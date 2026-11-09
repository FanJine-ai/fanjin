import { ARK_VIDEO_PROTOCOL_VERSION, ARK_VIDEO_PROTOCOL, arkVideoCheckpoint, arkProviderPayload, arkVideoPlan, assertArkVideoCheckpoint, formatArkVideoTask, hasArkVideoResult, isArkVideoTask, parseArkVideoRequest, arkProtocolError } from "@/lib/arkVideoProtocol";
import { assertDraftFinalPayload, draftTaskInfo, draftPricingPayload, resolveDraftParent } from "./seedanceDraft";
import {
  isPortraitPreparationPending, isRelayPortraitPreparing, readRelayPortraitPreparation,
  relayPortraitPreparationView,
  PORTRAIT_PREPARATION_TIMEOUT_MS, PORTRAIT_PREPARATION_VERSION,
  type RelayPortraitPreparation,
} from "./relayPortraitPreparation";
import { resolveCanonicalGenerationReferences } from "./generationReferenceResolver";
import { requireLiveWorkspaceAuthority } from "./workspaceAccess";
import {
  assertLiveWorkspaceApiKeyOwner,
  lockLivePlatformApiKeyFundingAuthority,
  lockLivePlatformApiKeyUsers,
} from "./apiKeyAuthority";
import { checkProjectPermission } from "@/middleware/projectAccess";
import { parseStoredRelayApiKeyPermissions } from "@/lib/relayApiKeyPermissions";
import { resolveUpstreamRealPersonRejection } from "@/lib/portraitUpstreamRejection";
import { resolveVideoReferenceDurations } from "@/lib/videoReferenceDuration";
import { assertRequestVideoTokenEstimate, resolveVideoTokenReservation } from "@/lib/videoTokenReservation";
import { isDefinitiveVideoTerminalRejection } from "@/lib/videoTerminalRejection";
import { VIDEO_RESERVATION_EXPIRY_POLICY, VIDEO_RESERVATION_EXPIRED_MESSAGE } from "@/lib/videoReservationExpiry";
import { internalModelId, publicModelId, publicH3Text, modelAllowlistIncludes } from "@/lib/minimaxH3PublicIdentity";
import { projectControlledVideoProviderPayload } from "@/lib/publicLegacyTextVideoPayload";
import { assertMembershipFundingBeforeDispatch } from "./membershipFunding";
import { assertMembershipFeature } from "./membership";
import { acquireWorkspaceGeneration, recordWorkspaceGenerationQueue, WorkspaceGenerationQueued } from "./workspaceResources";
import { Knex } from "knex";
import { isVideoPersistenceRetryWaiting, nextVideoPersistenceRetry, VIDEO_PERSISTENCE_RETRY_MESSAGE } from "@/lib/videoPersistenceRetry";
import { findMediaService, mediaServiceTable, mediaKitRuntimeConfig, mediaKitExistingTaskQueryConfig, lockMediaServiceForTask } from "@/lib/mediaServices";
import { MEDIA_SERVICE_TABLE } from "@/lib/migrations/mediaServices";
import crypto from "node:crypto";
import { isDefinitiveVideoRejection } from "@/lib/definitiveVideoRejection";
import { markPortraitUpstreamIdentityRejected } from "@/lib/portraitAdmissionStore";
import fs from "node:fs";
import { v4 as uuid } from "uuid";
import { db } from "@/utils/db";
import { notifyAgentVideoGenerationTaskTerminal } from "@/agent-runtime/agentTaskCompletionNotifier";
import {
  BillingError,
  completeRelayBilling,
  markApiTaskReservationDispatched,
  markApiTaskReservationPendingReconcile,
  releaseApiTaskReservation,
  reserveRelayBilling,
  resolveProviderSpecificPricingRule,
  settleApiTaskReservation,
  type PricingRule,
  type RelayVideoBillingMutationFence,
} from "@/lib/billing";
import {
  completeApiKeyQuota,
  completeApiKeyRequestQuota,
  reserveApiKeyRequestQuota,
} from "@/middleware/apiKeyAuth";
import {
  assertProviderDispatchAllowed,
  isPreviewProviderDispatchDisabled,
  providerCredentialFallbackEnvNames,
  resolveChannelApiKey,
  resolveChannelBaseUrl,
} from "@/lib/relayChannelCredential";
import {
  inspectProviderChannelPortraitCredential,
  readProviderChannelPortraitCredentialMetadata,
} from "@/lib/providerChannelCredentials";
import {
  acquireFormalCandidateVideoDispatchLease,
  disposeFormalCandidateVideoDispatchLease,
  getFormalCandidateVideoDispatchLease,
  isFormalCandidateCredentialRuntimeDeclared,
  type FormalCandidateVideoDispatchLease,
} from "@/lib/formalCandidateCredentialRuntime";
import { channelSupportsRequestedModel, selectPreferredModelRouteScope } from "@/lib/channelRouter";
import { insertAndReturnId, isPostgresClient } from "@/lib/dbDialect";
import { registerAccountOwnedAssetIfAvailable } from "@/lib/accountWorkspaceAssetLibrary";
import { readVideoTokenReservationUpperBound } from "@/lib/productionPricing";
import {
  calculateResolvedVideoInputCost,
  resolveVideoInputPricing,
  videoInputPricingTierForRequestPayload,
  type VideoInputPricingTier,
} from "@/lib/videoInputPricing";
import {
  assertCertifiedModelRouteForBilling,
  ModelRouteCertificationError,
} from "@/lib/modelRouteCertification";
import { multiplyPricingMicros, resolveTimePricing } from "@/lib/timePricing";
import { redactSensitiveText } from "@/lib/redactSensitiveText";
import {
  RELAY_SYNTHETIC_QUARANTINE_MESSAGE,
  publicRelayStatus,
  relaySuccessFilterStatuses,
  shouldQuarantineRelayArtifacts,
} from "@/lib/relayMockPolicy";
import {
  enqueueRelayCallbackDelivery,
  getRelayCallbackDeliveryByTask,
  isSafeRelayCallbackUrl,
  prepareRelayCallbackRequestPayload,
  processRelayCallbackDeliveryForTask,
  validateRelayCallbackUrl,
} from "@/lib/relayCallback";
import u from "@/utils";
import type {
  RelayScope,
  RelayProvider,
  RelayEndpointType,
  RelayTaskStatus,
  RelayChannel,
  CreateRelayTaskInput,
  VideoRouteConfig,
} from "@/lib/sharedTypes";
import {
  isInternalVideoResolution,
  isPublicVideoResolution,
  normalizeVideoResolution as normalizePublicVideoResolution,
  videoResolutionHeight,
} from "@/lib/videoResolutions";
import {
  isAsyncVideoRelayProvider,
  projectVideoRelayProviderRequest,
  videoRelayProviderCancelUrl,
  videoRelayProviderAuthorization,
  videoRelayProviderPollUrl,
  videoRelayProviderStatus,
  videoRelayProviderSubmitUrl,
  videoRelayProviderTaskId,
  videoRelayProviderVideoUrl,
} from "@/lib/videoRelayProviderAdapter";
import {
  calculateMiniMaxH3TerminalCost,
  resolveMiniMaxH3ReservationPricing,
} from "@/lib/minimaxH3Pricing";
import { applyGuChargeRounding, ceilGuChargeMicros, guChargeRoundingVersion } from "./billingUnits";
import { isMiniMaxH3Model } from "@/lib/minimaxH3Manifest";
import { autoDLH3SupportsResolution, isAutoDLH3Model } from "@/lib/autodlH3Manifest";
import {
  listFailoverCandidateRecipes,
  resolveFailoverFulfillmentPlan,
  type FulfillmentPlan,
  type VideoFulfillmentRecipe,
} from "@/lib/videoFulfillment/recipes";
import {
  isHighPublicVideoResolution,
  isVideoFulfillmentRecipeReady,
  resolveReadyVideoFulfillmentPlan,
} from "@/lib/videoFulfillment/availability";
import {
  isExactFanjinValueVideoPlan,
  isFanjinValueVideoModel,
} from "@/lib/fanjinValueVideoOffers";
import {
  calculateFanjinValueVideoActualCost,
  parseFanjinValueVideoPricingSnapshot,
  resolveFanjinValueVideoPricingSnapshot,
} from "@/lib/fanjinValueVideoPricing";
import {
  downloadPublicRemoteVideo,
  validatePublicRemoteVideoUrl,
  type SafeRemoteVideoDownloadTestHooks,
} from "@/lib/safeRemoteVideoDownload";
import { normalizeAndValidateProviderVideoPayload } from "@/lib/providerReferencePayload";
import {
  queueDurableObjectWriteCompensation,
  writeObjectWithDurableIntent,
} from "@/lib/durableObjectWrite";
import {
  commitObjectWriteIntentInTransaction,
  createObjectWriteMediaReferenceEvidence,
  type ObjectWriteIntentClaim,
} from "@/lib/objectWriteIntent";
import {
  createRelayFinalEvidenceDescriptor,
  createRelaySourceEvidenceDescriptor,
  publicDeliveryPart,
  publishRelayVideoDelivery,
  readRelayFinalEvidenceDescriptor,
  readRelaySourceEvidenceDescriptor,
  type RelayFinalEvidenceDescriptor,
} from "@/lib/videoFulfillment/deliveryConsumer";
import {
  PROVIDER_NATIVE_DELIVERY_AUTHORIZATION_VERSION,
  readProviderNativeDeliveryAuthorization,
  type ProviderNativeDeliveryAuthorization,
} from "@/lib/videoFulfillment/deliverySnapshot";
import {
  mirrorVideoToOwnedStorage,
  removeMirroredVideo,
  resolveOwnedVideoStorageKeyLocalPath,
} from "@/lib/videoFulfillment/safeVideoMirror";
import { createRelayVideoDeliveryProof } from "@/lib/videoFulfillment/deliveryProof";
import {
  fetchProviderSubmissionWithFreshConnection,
  providerSubmissionTransportErrorCode,
} from "@/lib/providerSubmissionTransport";
import {
  isRecoveryOnlyMode,
  recoveryOnlyRelayWorkDisposition,
} from "@/lib/recoveryOnlyMode";
import {
  VIDEO_GENERATION_REQUEST_VERSION,
  canonicalVideoGenerationRequest,
  videoGenerationRequestDigest,
  type VideoGenerationRequest,
} from "@/lib/videoGenerationContract";
import { createRelayWorkerExecutionAttestation } from "@/lib/relayWorkerExecutionAttestation";
import { processBootIdentity } from "@/lib/processBootIdentity";
import {
  parseStructuredTimelineRelayContext,
  structuredTimelineTextDigest,
  type StructuredTimelineRelayContext,
} from "@/lib/structuredThirtySecondTimeline";
import {
  bindPortraitProviderReferencesToPayload,
  resolveVideoAssetPolicyDecisions,
  resolvePortraitProviderReferencesForChannel,
  type PortraitProviderReferenceBinding,
  type TrustedVideoAssetPolicyEvidence,
} from "@/lib/videoAssetPolicy";
import { resolveFreshVideoAssetPolicyRelayBinding } from "@/lib/videoAssetPolicyRelayBinding";
import { containsLegacyVideoMediaRequest } from "@/lib/publicV3LegacyMediaAdmission";
import {
  PORTRAIT_ADMISSION_TABLE,
  PORTRAIT_CONSENT_TABLE,
  PORTRAIT_IDENTITY_TABLE,
  PORTRAIT_PROVIDER_ASSET_TABLE,
  PORTRAIT_PROVIDER_GROUP_TABLE,
} from "@/lib/migrations/portraitAssetAdmission";
import {
  acquireModelRouteCertificationAdvisoryFence,
  acquireModelRouteCertificationSessionFence,
} from "@/lib/modelRouteCertificationMutationFence";
import {
  assertBytePlusSeedance25PricingBinding,
  assertBytePlusSeedance25PricingRuleReadback,
  assertSeedance25CertificationProbePermit,
  assertSeedance25PricingBinding,
  assertSeedance25PricingRuleReadback,
  prepareSeedance25CertificationProbeRequest,
  SEEDANCE_25_ADAPTER_MAPPING_VERSION,
  BYTEPLUS_SEEDANCE_25_ADAPTER_MAPPING_VERSION,
  BYTEPLUS_SEEDANCE_25_MODEL_ID,
  SEEDANCE_25_MODEL_ID,
  SEEDANCE_25_RELAY_ADAPTER_BINDING_VERSION,
  type Seedance25CertificationProbePermit,
  type Seedance25PricingReadbackBinding,
  type Seedance25AnyPricingReadbackBinding,
} from "@/lib/seedance25Adapter";
import { assertSeedance25ArmedSnapshotForRuntime } from "@/lib/seedance25ProductionConfig";
import { SEEDANCE_25_CONTRACT_FAMILY } from "@/lib/videoGenerationContract";
import {
  RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_RELAY_EVIDENCE_KEY,
  abortReleaseFullMaintenancePrivateValidationBudgetSlotBeforeBillingInTransaction,
  assertReleaseFullMaintenancePrivateValidationBudgetSlotBinding,
  markReleaseFullMaintenancePrivateValidationBudgetDispatchInTransaction,
  markReleaseFullMaintenancePrivateValidationBudgetSlotPendingInTransaction,
  releaseFullMaintenancePrivateValidationBudgetSha256,
  releaseReleaseFullMaintenancePrivateValidationBudgetSlotInTransaction,
  reserveReleaseFullMaintenancePrivateValidationBudgetSlotGu,
  settleReleaseFullMaintenancePrivateValidationBudgetSlotInTransaction,
  type ReleaseFullMaintenancePrivateValidationBudgetSlotBinding,
} from "@/lib/releaseFullMaintenancePrivateValidationBudget";
import {
  assertQuickCreatePricingAuthorization,
  type QuickCreatePricingAuthorization,
} from "@/lib/quickCreatePricingConfirmation";

// 类型与常量从 sharedTypes 导入，保持创作台与中转站共用同一套类型契约。
// relayProviders / relayEndpointTypes 常量保留 re-export，供运行时校验和前端使用。
export { relayScopes, relayProviders, relayEndpointTypes } from "@/lib/sharedTypes";
export { isSafeRelayCallbackUrl, validateRelayCallbackUrl } from "@/lib/relayCallback";
export type {
  RelayScope,
  RelayProvider,
  RelayEndpointType,
  RelayTaskStatus,
  RelayChannel,
  CreateRelayTaskInput,
} from "@/lib/sharedTypes";

/**
 * Server-only approval ceiling carried from an Agent quote into Relay.
 * It is intentionally accepted only through `CreateRelayTaskOptions`, never
 * through the request-shaped `CreateRelayTaskInput` used by HTTP adapters.
 */
export interface RelayVideoBillingAuthorization {
  version: "agent-video-billing-authorization/v1";
  operation: "submit" | "retry";
  quoteId: string;
  pricingDigest: string;
  endpointType: "video_generation";
  workspaceId: string;
  projectId: number;
  pricingRuleId: string;
  pricingRuleUpdatedAt: number;
  provider: string;
  requestedModel: string;
  pricedModel: string | null;
  requestUnits: 1;
  unit: "task" | "video" | "token";
  pricingRuleBaseUnitPriceMicros: number;
  unitPriceMicros: number;
  multiplier: number;
  minimumMicros: number;
  videoInputPricingTier: VideoInputPricingTier;
  videoInputPricingConfigured: boolean;
  reservationUnits: number;
  reservationUpperBoundTokens: number | null;
  reservationCostMicros: number;
  maximumCostMicros: number;
  /**
   * Immutable generation + 480p→720p upscale pricing evidence for managed
   * Fanjin value offers. It is null/absent for every ordinary video model.
   */
  valueVideoPricingSnapshot?: Record<string, unknown> | null;
  currency: "GU";
}

export type RelayVideoBillingAuthorizationFacts = Omit<
  RelayVideoBillingAuthorization,
  "operation"
>;

export interface CreateRelayTaskOptions {
  /** Official wire protocol, set by the API adapter, never by request JSON. */
  trustedArkVideoProtocol?: typeof ARK_VIDEO_PROTOCOL;
  /** Server-only entrypoint permission; never accept this from request JSON. */
  trustedGenerationKeyPermission?: "generation:create" | "relay:video_generation";
  /** Trusted server-only facts; never construct these from an HTTP body. */
  trustedVideoBillingAuthorization?: RelayVideoBillingAuthorization | null;
  /** Quick Create user-confirmed hard ceiling, enforced on the live Relay plan. */
  trustedQuickCreatePricingAuthorization?: QuickCreatePricingAuthorization | null;
  /** Require a valid Quick Create ceiling for every newly-created paid task. */
  requireQuickCreatePricingConfirmation?: boolean;
  /**
   * Return the exact idempotent task when present; otherwise fail before
   * routing, pricing, reservation, task creation or provider dispatch.
   */
  idempotentReplayOnly?: boolean;
  /** Server-constructed canonical DTO bound immutably to task/audit state. */
  trustedCanonicalVideoGeneration?: {
    request: VideoGenerationRequest;
    digest: string;
  } | null;
  /** Server-constructed 30 second timeline proof; never sent to a provider. */
  trustedStructuredTimeline?: StructuredTimelineRelayContext | null;
  /** Server-only signed asset-policy proof; never sent to a provider or client. */
  trustedVideoAssetPolicyEvidence?: TrustedVideoAssetPolicyEvidence | null;
  /** Exact server-created provider adapter proof; never accepted from HTTP. */
  trustedVideoProviderAdapter?: {
    version: string;
    contractFamily: string;
    adapterMappingVersion: string;
    providerModel: string;
    pricingReadback: Seedance25AnyPricingReadbackBinding;
  } | null;
  /**
   * Server-only durable release-validation budget authority. HTTP request
   * bodies must never be projected into this field.
   */
  trustedPrivateValidationBudget?:
    ReleaseFullMaintenancePrivateValidationBudgetSlotBinding | null;
}

type TrustedCanonicalVideoGeneration = NonNullable<
  CreateRelayTaskOptions["trustedCanonicalVideoGeneration"]
>;

type TrustedStructuredTimeline = NonNullable<
  CreateRelayTaskOptions["trustedStructuredTimeline"]
>;

type TrustedVideoAssetPolicyRelayEvidence = NonNullable<
  CreateRelayTaskOptions["trustedVideoAssetPolicyEvidence"]
>;

type TrustedVideoProviderAdapter = NonNullable<
  CreateRelayTaskOptions["trustedVideoProviderAdapter"]
>;

type TrustedPrivateValidationBudget = NonNullable<
  CreateRelayTaskOptions["trustedPrivateValidationBudget"]
>;

const SEEDANCE_25_CERTIFICATION_PROBE_BRAND = Symbol(
  "seedance25-certification-probe-relay-boundary",
);

type Seedance25CertificationProbeInternalContext = {
  brand: typeof SEEDANCE_25_CERTIFICATION_PROBE_BRAND;
  permit: Seedance25CertificationProbePermit;
  pricingReadback: Seedance25PricingReadbackBinding;
};

type ResolvedSeedance25CertificationProbe = {
  permit: Seedance25CertificationProbePermit;
  pricingReadback: Seedance25PricingReadbackBinding;
  routeRow: Record<string, any>;
  channelRow: Record<string, any>;
};

function canonicalVideoBindingError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, status: 409, statusCode: 409 });
}

function seedance25CertificationProbeError(
  code: string,
  message: string,
  status = 409,
): Error & { code: string; status: number; statusCode: number } {
  return Object.assign(new Error(message), { code, status, statusCode: status });
}

function validateTrustedCanonicalVideoGeneration(
  input: CreateRelayTaskInput,
  binding: TrustedCanonicalVideoGeneration | null,
): TrustedCanonicalVideoGeneration | null {
  if (!binding) return null;
  if (input.endpointType !== "video_generation") {
    throw canonicalVideoBindingError(
      "canonical_video_endpoint_mismatch",
      "统一视频请求只能绑定视频生成任务",
    );
  }
  const request = canonicalVideoGenerationRequest(binding.request);
  const digest = videoGenerationRequestDigest(request);
  if (binding.digest !== digest) {
    throw canonicalVideoBindingError("canonical_video_digest_mismatch", "统一视频请求摘要不一致");
  }
  const payload = input.requestPayload;
  if (request.renderMode === "finalize") {
    assertDraftFinalPayload(payload, request);
    return { request, digest };
  }
  if ((payload.draft === true) !== (request.renderMode === "draft")) {
    throw canonicalVideoBindingError("draft_dispatch_mismatch", "样片标记与实际请求不一致");
  }
  const content = Array.isArray(payload.content) ? payload.content : [];
  const prompt = content
    .map((item) => item && typeof item === "object" ? item as Record<string, unknown> : {})
    .find((item) => item.type === "text" && typeof item.text === "string")?.text;
  const providerInputs = content.filter((item) => (
    item && typeof item === "object" && (item as Record<string, unknown>).type !== "text"
  ));
  if (
    String(prompt || "").trim() !== request.prompt
    || String(payload.ratio || "").trim() !== request.aspectRatio
    || Number(payload.duration) !== request.durationSeconds
    || String(payload.resolution || "").trim() !== request.outputResolution
    || (payload.output_format === undefined ? undefined : String(payload.output_format)) !== request.outputFormat
    || payload.generate_audio !== request.generateAudio
    || providerInputs.length !== request.inputs.length
  ) {
    throw canonicalVideoBindingError(
      "canonical_video_dispatch_mismatch",
      "统一视频请求与实际派发载荷不一致",
    );
  }
  return { request, digest };
}

function validateTrustedVideoProviderAdapter(
  input: CreateRelayTaskInput,
  binding: TrustedVideoProviderAdapter | null,
  canonicalBinding: TrustedCanonicalVideoGeneration | null,
): TrustedVideoProviderAdapter | null {
  if (!binding) return null;
  let pricingReadback: Seedance25AnyPricingReadbackBinding;
  try {
    pricingReadback = binding.providerModel === BYTEPLUS_SEEDANCE_25_MODEL_ID
      ? assertBytePlusSeedance25PricingBinding(binding.pricingReadback)
      : assertSeedance25PricingBinding(binding.pricingReadback);
  } catch {
    throw canonicalVideoBindingError(
      "video_provider_adapter_pricing_binding_invalid",
      "可信视频供应商 Adapter 缺少有效的 Seedance 2.5 双档定价读回绑定",
    );
  }
  if (
    input.endpointType !== "video_generation"
    || !canonicalBinding
    || binding.version !== SEEDANCE_25_RELAY_ADAPTER_BINDING_VERSION
    || binding.contractFamily !== SEEDANCE_25_CONTRACT_FAMILY
    || binding.adapterMappingVersion !== (binding.providerModel === BYTEPLUS_SEEDANCE_25_MODEL_ID
      ? BYTEPLUS_SEEDANCE_25_ADAPTER_MAPPING_VERSION : SEEDANCE_25_ADAPTER_MAPPING_VERSION)
    || ![SEEDANCE_25_MODEL_ID, BYTEPLUS_SEEDANCE_25_MODEL_ID].includes(binding.providerModel as typeof SEEDANCE_25_MODEL_ID)
    || input.model !== binding.providerModel
    || String(input.requestPayload.model || "") !== binding.providerModel
    || !["generate", "extend", "edit"].includes(canonicalBinding.request.operation)
    || (canonicalBinding.request.renderMode !== "finalize" && ["extend", "edit"].includes(canonicalBinding.request.operation) && (
      input.requestPayload.omni_reference_task_type !== canonicalBinding.request.operation
      || canonicalBinding.request.aspectRatio !== "adaptive"
    ))
    || (canonicalBinding.request.operation === "edit" && canonicalBinding.request.durationSeconds !== -1)
    || (canonicalBinding.request.operation === "generate" && ["extend", "edit"].includes(String(input.requestPayload.omni_reference_task_type)))
  ) {
    throw canonicalVideoBindingError(
      "video_provider_adapter_binding_invalid",
      "可信视频供应商 Adapter 绑定与统一请求不一致",
    );
  }
  return { ...binding, pricingReadback };
}

function assertPersistedVideoProviderAdapter(
  row: { resultPayload?: unknown },
  binding: TrustedVideoProviderAdapter | null,
): void {
  const internal = parseJsonObject(parseJsonObject(row.resultPayload).internal);
  const stored = parseJsonObject(internal.videoProviderAdapter);
  const hasStored = Object.keys(stored).length > 0;
  if (!binding && !hasStored) return;
  if (!binding || !hasStored || JSON.stringify(stored) !== JSON.stringify(binding)) {
    throw canonicalVideoBindingError(
      "video_provider_adapter_idempotency_conflict",
      "幂等 Relay 任务的供应商 Adapter 绑定不一致",
    );
  }
}

function validateTrustedPrivateValidationBudget(
  input: CreateRelayTaskInput,
  bindingValue: TrustedPrivateValidationBudget | null,
  certificationProbe: boolean,
): TrustedPrivateValidationBudget | null {
  if (!bindingValue) return null;
  const binding = assertReleaseFullMaintenancePrivateValidationBudgetSlotBinding(bindingValue);
  if (
    input.endpointType !== "video_generation"
    || String(input.workspaceId || "") !== binding.workspaceId
    || Number(input.projectId) !== binding.projectId
    || (certificationProbe && binding.slot !== "seedance")
    || (!certificationProbe && binding.slot !== "portrait")
  ) {
    throw canonicalVideoBindingError(
      "private_validation_budget_scope_mismatch",
      "私有验证预算槽与 Relay 任务作用域不匹配",
    );
  }
  return binding;
}

function assertPrivateValidationBudgetSingleProviderTaskPlan(
  binding: TrustedPrivateValidationBudget | null,
  plan: VideoResolutionPlan | null,
): void {
  if (!binding || !plan?.needsEnhancement) return;
  throw canonicalVideoBindingError(
    "private_validation_budget_multi_provider_task_forbidden",
    "私有验证预算只允许一次上游任务，当前履约计划还需要额外高清处理任务",
  );
}

function privateValidationBudgetPricingEvidenceSha256(input: {
  binding: TrustedPrivateValidationBudget;
  relayInput: CreateRelayTaskInput;
  channel: RelayChannel;
  pricing: VideoPricingPlan;
}): string {
  return releaseFullMaintenancePrivateValidationBudgetSha256({
    format: "fanjin-release-full-maintenance-private-validation-budget-pricing/v1",
    bindingSha256: input.binding.bindingSha256,
    workspaceId: input.relayInput.workspaceId,
    projectId: input.relayInput.projectId,
    requestId: input.relayInput.requestId,
    provider: input.channel.provider,
    channelId: input.channel.id,
    requestedModel: input.relayInput.model ?? null,
    pricedModel: input.pricing.rule.model,
    unit: input.pricing.unit,
    reservationUnits: input.pricing.reservationUnits,
    reservationGuMicros: input.pricing.costMicros,
    priceSnapshot: input.pricing.priceSnapshot,
  });
}

const PRIVATE_VALIDATION_BUDGET_PRICING_CHECKPOINT_KEY =
  "releaseFullMaintenancePrivateValidationBudgetPricing";
const PRIVATE_VALIDATION_BUDGET_PRICING_CHECKPOINT_FORMAT =
  "fanjin-release-full-maintenance-private-validation-budget-pricing-checkpoint/v1";

interface PrivateValidationBudgetPricingCheckpoint {
  format: typeof PRIVATE_VALIDATION_BUDGET_PRICING_CHECKPOINT_FORMAT;
  pricingEvidenceSha256: string;
  priceSnapshot: Record<string, unknown>;
}

function privateValidationBudgetPricingCheckpointError(message: string): never {
  throw canonicalVideoBindingError(
    "private_validation_budget_pricing_checkpoint_invalid",
    message,
  );
}

function privateValidationBudgetPricingCheckpointFromInternal(
  internalValue: unknown,
): PrivateValidationBudgetPricingCheckpoint | null {
  const internal = parseJsonObject(internalValue);
  const stored = internal[PRIVATE_VALIDATION_BUDGET_PRICING_CHECKPOINT_KEY];
  if (stored === undefined || stored === null) return null;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    privateValidationBudgetPricingCheckpointError(
      "Relay 私有验证预算价格检查点已损坏",
    );
  }
  const record = stored as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join("\0") !== ["format", "priceSnapshot", "pricingEvidenceSha256"]
      .sort()
      .join("\0")
    || record.format !== PRIVATE_VALIDATION_BUDGET_PRICING_CHECKPOINT_FORMAT
    || !/^[a-f0-9]{64}$/.test(String(record.pricingEvidenceSha256 || ""))
    || !record.priceSnapshot
    || typeof record.priceSnapshot !== "object"
    || Array.isArray(record.priceSnapshot)
    || Object.keys(record.priceSnapshot as Record<string, unknown>).length === 0
  ) {
    privateValidationBudgetPricingCheckpointError(
      "Relay 私有验证预算价格检查点已损坏",
    );
  }
  return {
    format: PRIVATE_VALIDATION_BUDGET_PRICING_CHECKPOINT_FORMAT,
    pricingEvidenceSha256: String(record.pricingEvidenceSha256),
    priceSnapshot: { ...record.priceSnapshot as Record<string, unknown> },
  };
}

function restorePrivateValidationBudgetPricingPlan(input: {
  resolvedPricing: VideoPricingPlan;
  checkpoint: PrivateValidationBudgetPricingCheckpoint;
}): VideoPricingPlan {
  const { resolvedPricing, checkpoint } = input;
  const snapshot = checkpoint.priceSnapshot;
  const unit = String(snapshot.unit || "");
  const pricingRuleBaseUnitPriceMicros = Number(snapshot.pricingRuleBaseUnitPriceMicros);
  const unitPriceMicros = Number(snapshot.unitPriceMicros);
  const multiplier = Number(snapshot.multiplier);
  const baseMultiplier = Number(snapshot.baseMultiplier);
  const minimumMicros = Number(snapshot.minimumMicros);
  const reservationUnits = Number(snapshot.reservationUnits);
  const costMicros = Number(snapshot.costMicros);
  const videoInputPricingTier = String(snapshot.videoInputPricingTier || "");
  const videoInputPricingConfigured = snapshot.videoInputPricingConfigured;
  const timePricing = snapshot.timePricing;
  const timePricingRecord = timePricing
    && typeof timePricing === "object"
    && !Array.isArray(timePricing)
      ? timePricing as Record<string, unknown>
      : null;
  const timeMultiplierBps = Number(timePricingRecord?.multiplierBps);
  const timeMultiplier = Number(timePricingRecord?.multiplier);
  const valueVideoPricingSnapshot = snapshot.fanjinValueVideoPricing == null
    ? null
    : snapshot.fanjinValueVideoPricing
      && typeof snapshot.fanjinValueVideoPricing === "object"
      && !Array.isArray(snapshot.fanjinValueVideoPricing)
        ? snapshot.fanjinValueVideoPricing as Record<string, unknown>
        : privateValidationBudgetPricingCheckpointError(
            "Relay 私有验证预算价格检查点的组合定价快照无效",
          );
  const rule = resolvedPricing.rule;
  const frozenIdentityMatches =
    String(snapshot.pricingRuleId || "") === rule.id
    && Number(snapshot.pricingRuleUpdatedAt) === rule.updateTime
    && String(snapshot.endpointType || "") === rule.endpointType
    && (snapshot.provider == null ? null : String(snapshot.provider)) === rule.provider
    && (snapshot.model == null ? null : String(snapshot.model)) === rule.model
    && String(snapshot.currency || "") === rule.currency
    && pricingRuleBaseUnitPriceMicros === rule.unitPriceMicros;
  const frozenValuesValid =
    ["task", "video", "token"].includes(unit)
    && Number.isSafeInteger(pricingRuleBaseUnitPriceMicros)
    && pricingRuleBaseUnitPriceMicros > 0
    && Number.isSafeInteger(unitPriceMicros)
    && unitPriceMicros > 0
    && Number.isFinite(baseMultiplier)
    && baseMultiplier > 0
    && Number.isFinite(multiplier)
    && multiplier > 0
    && Number.isSafeInteger(minimumMicros)
    && minimumMicros >= 0
    && Number.isSafeInteger(reservationUnits)
    && reservationUnits > 0
    && Number.isSafeInteger(costMicros)
    && costMicros > 0
    && ["with_video_input", "without_video_input"].includes(videoInputPricingTier)
    && typeof videoInputPricingConfigured === "boolean"
    && timePricingRecord !== null
    && typeof timePricingRecord.configured === "boolean"
    && Number.isSafeInteger(Number(timePricingRecord.evaluatedAt))
    && Number(timePricingRecord.evaluatedAt) > 0
    && typeof timePricingRecord.timezone === "string"
    && String(timePricingRecord.timezone).length > 0
    && Number.isSafeInteger(timeMultiplierBps)
    && timeMultiplierBps > 0
    && timeMultiplier === timeMultiplierBps / 10_000
    && multiplier === baseMultiplier * timeMultiplier
    && (unit === "token"
      ? Number(snapshot.reservationUpperBoundTokens) === reservationUnits
      : snapshot.reservationUpperBoundTokens === null);
  if (!frozenIdentityMatches || !frozenValuesValid) {
    privateValidationBudgetPricingCheckpointError(
      "Relay 私有验证预算价格检查点与定价规则或冻结事实不一致",
    );
  }
  return {
    ...resolvedPricing,
    unit: unit as VideoPricingPlan["unit"],
    pricingRuleBaseUnitPriceMicros,
    unitPriceMicros,
    multiplier,
    minimumMicros,
    videoInputPricingTier: videoInputPricingTier as VideoInputPricingTier,
    videoInputPricingConfigured,
    reservationUnits,
    costMicros,
    valueVideoPricingSnapshot,
    priceSnapshot: { ...snapshot },
  };
}

type PrivateValidationBudgetRelayRow = {
  endpointType?: unknown;
  workspaceId?: unknown;
  projectId?: unknown;
  resultPayload?: unknown;
};

function privateValidationBudgetFromInternal(
  internalValue: unknown,
): TrustedPrivateValidationBudget | null {
  const internal = parseJsonObject(internalValue);
  const stored = internal[
    RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_RELAY_EVIDENCE_KEY
  ];
  if (stored === undefined || stored === null) return null;
  try {
    return assertReleaseFullMaintenancePrivateValidationBudgetSlotBinding(stored);
  } catch {
    throw canonicalVideoBindingError(
      "private_validation_budget_checkpoint_invalid",
      "Relay 私有验证预算检查点已损坏",
    );
  }
}

function storedPrivateValidationBudget(
  row: PrivateValidationBudgetRelayRow,
): TrustedPrivateValidationBudget | null {
  const binding = privateValidationBudgetFromInternal(
    parseJsonObject(row.resultPayload).internal,
  );
  if (!binding) return null;
  if (
    String(row.endpointType || "") !== "video_generation"
    || String(row.workspaceId || "") !== binding.workspaceId
    || Number(row.projectId) !== binding.projectId
  ) {
    throw canonicalVideoBindingError(
      "private_validation_budget_checkpoint_scope_mismatch",
      "Relay 私有验证预算检查点与任务作用域不匹配",
    );
  }
  return binding;
}

function assertPersistedPrivateValidationBudget(
  row: PrivateValidationBudgetRelayRow,
  binding: TrustedPrivateValidationBudget | null,
): void {
  const stored = storedPrivateValidationBudget(row);
  if (!binding && !stored) return;
  if (!binding || !stored || stored.bindingSha256 !== binding.bindingSha256) {
    throw canonicalVideoBindingError(
      "private_validation_budget_idempotency_conflict",
      "幂等 Relay 任务的私有验证预算绑定不一致",
    );
  }
}

function assertPersistedSeedance25CertificationProbe(
  row: { resultPayload?: unknown },
  permit: Seedance25CertificationProbePermit | null,
): void {
  const internal = parseJsonObject(parseJsonObject(row.resultPayload).internal);
  const stored = parseJsonObject(internal.seedance25CertificationProbe);
  const hasStored = Object.keys(stored).length > 0;
  if (!permit && !hasStored) return;
  if (
    !permit
    || !hasStored
    || stableStringifyJson(stored) !== stableStringifyJson(permit)
  ) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_idempotency_conflict",
      "幂等 Relay 任务的 Seedance 2.5 首次认证探针 permit 不一致",
    );
  }
}

function assertPersistedCanonicalVideoGeneration(
  row: { resultPayload?: unknown },
  binding: TrustedCanonicalVideoGeneration | null,
): void {
  if (!binding) return;
  const internal = parseJsonObject(parseJsonObject(row.resultPayload).internal);
  const stored = parseJsonObject(internal.canonicalVideoGeneration);
  // Pre-0.0.9 tasks have no binding; requestPayload equality remains their
  // compatibility proof. Once present, the binding is immutable.
  if (!Object.keys(stored).length) return;
  if (
    stored.digest !== binding.digest
    || JSON.stringify(stored.request) !== JSON.stringify(binding.request)
  ) {
    throw canonicalVideoBindingError(
      "canonical_video_idempotency_conflict",
      "幂等任务已绑定不同的统一视频请求",
    );
  }
}

function validateTrustedStructuredTimeline(
  input: CreateRelayTaskInput,
  binding: TrustedStructuredTimeline | null,
  canonicalBinding: TrustedCanonicalVideoGeneration | null,
): TrustedStructuredTimeline | null {
  if (!binding) return null;
  if (input.endpointType !== "video_generation" || !canonicalBinding) {
    throw canonicalVideoBindingError(
      "structured_timeline_endpoint_mismatch",
      "30 秒时间线只能绑定已校验的视频生成任务",
    );
  }
  let parsed: StructuredTimelineRelayContext;
  try {
    parsed = parseStructuredTimelineRelayContext(binding);
  } catch {
    throw canonicalVideoBindingError(
      "structured_timeline_binding_invalid",
      "30 秒时间线 Relay 绑定无效",
    );
  }
  if (
    parsed.canonicalRequestDigest !== canonicalBinding.digest
    || parsed.track.promptDigest
      !== structuredTimelineTextDigest(canonicalBinding.request.prompt)
    || parsed.track.durationMs
      !== Math.round(canonicalBinding.request.durationSeconds * 1_000)
  ) {
    throw canonicalVideoBindingError(
      "structured_timeline_dispatch_mismatch",
      "30 秒时间线绑定与实际派发请求不一致",
    );
  }
  return parsed;
}

function assertPersistedStructuredTimeline(
  row: Record<string, unknown>,
  binding: TrustedStructuredTimeline | null,
): void {
  const internal = parseJsonObject(parseJsonObject(row.resultPayload).internal);
  const storedRaw = internal.structuredTimeline;
  const hasStored = storedRaw != null;
  if (!binding && !hasStored) return;
  if (!binding || !hasStored) {
    throw canonicalVideoBindingError(
      "structured_timeline_idempotency_conflict",
      "幂等 Relay 任务的 30 秒时间线绑定不一致",
    );
  }
  let stored: StructuredTimelineRelayContext;
  try {
    stored = parseStructuredTimelineRelayContext(storedRaw);
  } catch {
    throw canonicalVideoBindingError(
      "structured_timeline_checkpoint_invalid",
      "Relay 内部的 30 秒时间线绑定已损坏",
    );
  }
  if (JSON.stringify(stored) !== JSON.stringify(binding)) {
    throw canonicalVideoBindingError(
      "structured_timeline_idempotency_conflict",
      "幂等 Relay 任务已绑定不同的 30 秒时间线",
    );
  }
}

function assertPersistedVideoAssetPolicyEvidence(
  row: Record<string, unknown>,
  binding: TrustedVideoAssetPolicyRelayEvidence | null,
): void {
  const internal = parseJsonObject(parseJsonObject(row.resultPayload).internal);
  const stored = parseJsonObject(internal.videoAssetPolicyEvidence);
  const hasStored = Object.keys(stored).length > 0;
  const preparation = readRelayPortraitPreparation(parseRelayTask(row));
  if (!binding && preparation?.initialPolicyEvidenceDigest === null) return;
  if (!binding && !hasStored) return;
  if (!binding || !hasStored) {
    throw canonicalVideoBindingError(
      "video_asset_policy_idempotency_conflict",
      "幂等 Relay 任务的素材策略证据不一致",
    );
  }
  if (
    (stored.evidenceDigest !== binding.evidenceDigest
      && !readRelayPortraitPreparation(parseRelayTask(row)))
    || stored.workspaceId !== binding.workspaceId
    || stored.projectId !== binding.projectId
    || JSON.stringify(stored.assetVersionIds) !== JSON.stringify(binding.assetVersionIds)
  ) {
    throw canonicalVideoBindingError(
      "video_asset_policy_idempotency_conflict",
      "幂等 Relay 任务已绑定不同的素材策略证据",
    );
  }
}

function persistedVideoAssetPolicyCheckpoint(task: RelayTask): {
  canonicalRequest: VideoGenerationRequest | null;
  storedEvidence: TrustedVideoAssetPolicyEvidence | null;
} {
  const internal = parseJsonObject(task.resultPayload.internal);
  const canonical = parseJsonObject(internal.canonicalVideoGeneration);
  let canonicalRequest: VideoGenerationRequest | null = null;
  if (internal.canonicalVideoGeneration !== undefined) {
    try {
      const storedRequest = parseJsonObject(canonical.request);
      // Canonicalization replaces the version; validate the persisted evidence first.
      if (storedRequest.version !== VIDEO_GENERATION_REQUEST_VERSION) throw new Error("version");
      canonicalRequest = canonicalVideoGenerationRequest(
        storedRequest as unknown as VideoGenerationRequest,
      );
      if (canonical.digest !== videoGenerationRequestDigest(canonicalRequest)) throw new Error("digest");
    } catch {
      throw canonicalVideoBindingError(
        "canonical_video_checkpoint_invalid",
        "Relay 内部的统一视频请求已损坏",
      );
    }
  }
  const storedEvidence = Object.keys(parseJsonObject(internal.videoAssetPolicyEvidence)).length
    ? internal.videoAssetPolicyEvidence as TrustedVideoAssetPolicyEvidence
    : null;
  return { canonicalRequest, storedEvidence };
}

async function validatePersistedVideoAssetPolicyBeforeDispatch(
  task: RelayTask,
  database: Knex | Knex.Transaction = db,
): Promise<{
  canonicalRequest: VideoGenerationRequest | null;
  portraitBindings: readonly PortraitProviderReferenceBinding[];
}> {
  if (isArkVideoTask(task)) {
    assertArkVideoCheckpoint(task);
    const channelRow = await database("o_provider_channel").where({ id: task.channelId }).first();
    if (!channelRow) throw arkProtocolError("供应商通道不可用", 503);
    await assertArkReferenceOwnership(task, parseRelayChannel(channelRow), database);
    return { canonicalRequest: null, portraitBindings: [] };
  }
  const { canonicalRequest, storedEvidence } = persistedVideoAssetPolicyCheckpoint(task);
  if (canonicalRequest?.renderMode === "finalize") {
    const parent = await database("o_relay_task").where({ id: canonicalRequest.draftSource?.taskId }).first();
    const current = resolveDraftParent(parent || null, { workspaceId: String(task.workspaceId), projectId: Number(task.projectId) });
    if (current.digest !== videoGenerationRequestDigest(canonicalRequest) || task.channelId !== canonicalRequest.draftSource?.channelId) {
      throw canonicalVideoBindingError("draft_parent_changed", "样片关联或通道已变化，已停止提交");
    }
    assertDraftFinalPayload(task.requestPayload, canonicalRequest);
  }
  await resolveFreshVideoAssetPolicyRelayBinding({
    database,
    canonicalRequest,
    workspaceId: String(task.workspaceId || ""),
    projectId: task.projectId == null ? "" : String(task.projectId),
    evidence: storedEvidence,
  });
  const portraitResolution = await resolvePortraitProviderReferencesForChannel({
    database,
    workspaceId: String(task.workspaceId || ""),
    projectId: task.projectId == null ? "" : String(task.projectId),
    assetVersionIds: canonicalRequest?.inputs.map((item) => item.assetVersionId) ?? [],
    providerChannelId: task.channelId,
    requirePortraitRegistration: task.provider === "volcano",
    providerModel: task.model,
  });
  return {
    canonicalRequest,
    portraitBindings: portraitResolution.bindings,
  };
}

export const PUBLIC_VIDEO_TASK_OBJECT = "content.generation.task" as const;
export const PUBLIC_VIDEO_TASK_STATUSES = [
  "queued",
  "running",
  "pending_reconcile",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type PublicVideoTaskStatus = (typeof PUBLIC_VIDEO_TASK_STATUSES)[number];

export interface RelayTask {
  id: string;
  apiKeyId: string | null;
  workspaceId: string | null;
  projectId: number | null;
  requestId: string | null;
  endpointType: RelayEndpointType;
  provider: RelayProvider | null;
  channelId: string | null;
  model: string | null;
  status: RelayTaskStatus;
  requestPayload: Record<string, unknown>;
  providerPayload: Record<string, unknown>;
  providerTaskId: string | null;
  resultPayload: Record<string, unknown>;
  errorMessage: string | null;
  quotaReserved: number;
  apiQuotaReserved: number;
  costMicros: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  attemptCount: number;
  heartbeatAt: number | null;
  createTime: number;
  updateTime: number;
  submittedAt: number | null;
  completedAt: number | null;
}

export interface RefreshRelayTaskOptions {
  /**
   * Recovery-only fence: an existing provider task may be polled, but this
   * refresh must never create a generation, failover, or enhancement task.
   */
  providerReadOnly?: boolean;
}

/**
 * The split API process owns enqueue/projection only. All provider mutation
 * and polling is reserved for the independently attested Relay Worker.
 */
export function shouldDeferRelayProviderWorkToDedicatedWorker(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  const role = String(
    environment.FANJIN_PROCESS_ROLE || environment.FANJIN_SERVICE_ROLE || "all",
  ).trim().toLowerCase();
  return role === "api" && environment.FANJIN_DISABLE_RELAY_WORKER === "1";
}

export class RelayWorkerCancellationRequiredError extends Error {
  readonly code = "relay_worker_cancel_required";
  readonly status = 503;

  constructor() {
    super("取消请求未受理：split API 不得访问上游，请由 Relay Worker 执行取消");
    this.name = "RelayWorkerCancellationRequiredError";
  }
}

const RELAY_WORKER_INSTANCE = `relay-${process.pid}-${Math.random().toString(16).slice(2)}`;

function createRelayLeaseOwner(): string {
  // Every claim is a fencing token, including multiple refresh callers inside
  // the same Node process. A process-wide owner lets an expired slow operation
  // pass the CAS after a newer operation in that process reclaims the row.
  return `${RELAY_WORKER_INSTANCE}:${uuid()}`;
}

interface RelayFinalizationFence {
  leaseOwner: string;
  providerTaskId: string;
}

class RelayFinalizationFenceError extends Error {
  constructor(message = "Relay finalization lease was lost") {
    super(message);
    this.name = "RelayFinalizationFenceError";
  }
}

class RelayEnhancementSubmissionHaltedError extends Error {
  constructor(message = "Relay enhancement submission halted without retry") {
    super(message);
    this.name = "RelayEnhancementSubmissionHaltedError";
  }
}

interface VideoResolutionPlan {
  requestedResolution: string | null;
  generationResolution: string | null;
  finalResolution: string | null;
  needsEnhancement: boolean;
  invalidResolution?: boolean;
  /** Set when caller requested a non-public deliverable such as 480p. */
  publicResolutionForbidden?: boolean;
  recipeId?: string | null;
  enhanceChannelId?: string | null;
  /** Provider-facing model selected by a fulfillment recipe; public SKU stays on task.model. */
  upstreamModel?: string | null;
  /** 路径 A failover 留痕:已被放弃(失败并切换)的配方尝试,按发生顺序排列。 */
  attempts?: VideoRecipeAttempt[];
  /** Server-owned exact authorization for a provider-native non-public output tier. */
  providerNativeDeliveryAuthorization?: ProviderNativeDeliveryAuthorization;
}

/** 一次被放弃的配方尝试留痕(design §5.1);当前/最终配方始终是 internal.recipeId。 */
interface VideoRecipeAttempt {
  recipeId: string | null;
  channelId: string | null;
  outcome: string;
  message?: string;
  at: number;
}

/** Internal generate + legacy tokens. Public requests must use isPublicVideoResolution. */
const VALID_VIDEO_RESOLUTIONS = ["480p", "720p", "768p", "960p", "1080p", "2k", "4k", "2160p"] as const;
type ValidVideoResolution = (typeof VALID_VIDEO_RESOLUTIONS)[number];

function isValidVideoResolution(value: string | null | undefined): value is ValidVideoResolution {
  if (!value) return false;
  if (isInternalVideoResolution(value)) return true;
  return VALID_VIDEO_RESOLUTIONS.includes(value as ValidVideoResolution);
}

export interface RelayTaskProgress {
  status: string;
  stage: "queued" | "generating" | "processing" | "completed" | "failed" | "cancelled";
  stageLabel: string;
  progress: number;
  progressPercent: number;
  targetResolution: string | null;
  needsTargetProcessing: boolean;
}

interface VideoEnhanceConfig {
  submitEndpoint: string;
  statusEndpoint: string | null;
  apiKey: string;
  mode: VideoEnhanceMode;
}

const DEFAULT_VIDEO_ENHANCE_SUBMIT_ENDPOINTS = {
  generative: "https://mediakit.cn-beijing.volces.com/api/v1/tools/enhance-video-generative",
  standard: "https://mediakit.cn-beijing.volces.com/api/v1/tools/enhance-video",
} as const;
const DEFAULT_VIDEO_ENHANCE_STATUS_ENDPOINT = "https://mediakit.cn-beijing.volces.com/api/v1/tasks/{taskId}";
type VideoEnhanceMode = keyof typeof DEFAULT_VIDEO_ENHANCE_SUBMIT_ENDPOINTS;

export interface StoreMediaAssetInput {
  taskId: string;
  workspaceId?: string | null;
  projectId?: number | null;
  assetType: "video" | "image" | "audio" | "file";
  source?: string;
  url?: string | null;
  localPath?: string | null;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  metadata?: Record<string, unknown>;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function stableStringifyJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.keys(input as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = normalize((input as Record<string, unknown>)[key]);
          return acc;
        }, {});
    }
    return input;
  };
  return JSON.stringify(normalize(value ?? {}));
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (!value || typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeProviderModelName(model?: string | null): string | null {
  const value = String(model || "").trim();
  if (!value) return null;
  const match = value.match(/^[A-Za-z0-9_-]+:(.+)$/);
  return internalModelId(match ? match[1] : value);
}

type RelayTaskProjectAuthorityErrorCode =
  | "project_id_required"
  | "invalid_project_id"
  | "relay_task_workspace_required"
  | "relay_task_project_not_found"
  | "relay_task_project_not_active";

function relayTaskProjectAuthorityError(
  code: RelayTaskProjectAuthorityErrorCode,
  message: string,
  status: number,
): Error & { code: RelayTaskProjectAuthorityErrorCode; status: number; statusCode: number } {
  const error = new Error(message) as Error & {
    code: RelayTaskProjectAuthorityErrorCode;
    status: number;
    statusCode: number;
  };
  error.code = code;
  error.status = status;
  error.statusCode = status;
  return error;
}

function normalizeRelayTaskInput(input: CreateRelayTaskInput, arkProtocol = false): CreateRelayTaskInput {
  const model = normalizeProviderModelName(input.model);
  const projectId = input.projectId == null
    ? null
    : typeof input.projectId === "number"
      ? input.projectId
      : Number.NaN;
  if (input.endpointType === "video_generation" && projectId === null && !arkProtocol) {
    throw relayTaskProjectAuthorityError(
      "project_id_required",
      "video_generation relay task requires projectId",
      400,
    );
  }
  if (
    projectId !== null
    && (!Number.isSafeInteger(projectId) || projectId <= 0)
  ) {
    throw relayTaskProjectAuthorityError(
      "invalid_project_id",
      "projectId 无效",
      400,
    );
  }
  const payload = { ...input.requestPayload };
  if (typeof payload.model === "string") {
    payload.model = normalizeProviderModelName(payload.model) || payload.model;
  }
  return {
    ...input,
    model,
    projectId,
    requestPayload: payload,
  };
}

function isTerminalStatus(status: RelayTaskStatus): boolean {
  return ["mocked", "succeeded", "failed", "cancelled"].includes(status);
}

function isActiveStatus(status: RelayTaskStatus): boolean {
  return ["queued", "running", "enhancing"].includes(status);
}

function relayLeaseMs(): number {
  const configured = Number(process.env.FANJIN_RELAY_LEASE_MS || 5 * 60 * 1000);
  return Number.isFinite(configured) && configured > 0 ? configured : 5 * 60 * 1000;
}

export function normalizeKnownProviderStatus(status: unknown): RelayTaskStatus | null {
  if (typeof status !== "string") return null;
  const value = status.toLowerCase();
  if (["queued", "created", "pending", "submitted", "waiting"].includes(value)) return "queued";
  if (["running", "processing", "in_progress", "generating"].includes(value)) return "running";
  if (["succeeded", "success", "done", "completed", "complete"].includes(value)) return "succeeded";
  if (["failed", "fail", "failure", "error", "expired", "timeout", "timed_out"].includes(value)) return "failed";
  if (["cancelled", "canceled"].includes(value)) return "cancelled";
  return null;
}

function normalizeProviderStatus(status: unknown): RelayTaskStatus {
  return normalizeKnownProviderStatus(status) || "queued";
}

function resolveProviderApiKey(channel: RelayChannel): string {
  return resolveChannelApiKey(
    channel,
    providerCredentialFallbackEnvNames(channel.provider, channel.endpointType),
  );
}

export function getProviderCredentialStatus(
  channelOrRef: RelayChannel | string | null | undefined,
): { credentialRef: string | null; credentialReady: boolean } {
  const channel = typeof channelOrRef === "object" && channelOrRef
    ? channelOrRef
    : null;
  const credentialRef = channel
    ? channel.credentialRef
    : typeof channelOrRef === "string"
      ? channelOrRef
      : null;
  if (isPreviewProviderDispatchDisabled()) {
    return { credentialRef, credentialReady: false };
  }
  return {
    credentialRef,
    credentialReady: channel
      ? Boolean(resolveProviderApiKey(channel))
      : Boolean(resolveChannelApiKey({
          provider: "volcano",
          endpointType: "text",
          credentialRef,
        }, ["VOLCANO_ARK_API_KEY"])),
  };
}

function resolveVideoEnhanceMode(): VideoEnhanceMode {
  return process.env.VOLCANO_VIDEO_ENHANCE_MODE === "standard" ? "standard" : "generative";
}

export function getVideoEnhanceStatus(): { configured: boolean; submitEndpoint: boolean; statusEndpoint: boolean; mode: VideoEnhanceMode } {
  const config = resolveVideoEnhanceConfig();
  return {
    configured: Boolean(config),
    submitEndpoint: Boolean(config?.submitEndpoint),
    statusEndpoint: Boolean(config?.statusEndpoint),
    mode: config?.mode ?? resolveVideoEnhanceMode(),
  };
}

function readByPath(obj: any, path: string): unknown {
  if (!obj || !path) return undefined;
  const normalized = path.replace(/\[(\d+)\]/g, ".$1");
  return normalized.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function pickFirst(obj: any, paths: string[]): unknown {
  for (const path of paths) {
    const value = readByPath(obj, path);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function normalizeResolution(value: unknown): string | null {
  // 2K is an independent public tier (height 1440), not an alias of 1080p.
  return normalizePublicVideoResolution(value);
}

function resolutionHeight(resolution: string | null): number {
  return videoResolutionHeight(resolution);
}

function parseVideoRouteConfig(raw: unknown): VideoRouteConfig | null {
  let parsed = raw;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  // High public tiers must be backed by an explicit native claim. Historical
  // `resolutions` remains a compatibility source for <=1080p only; otherwise
  // an administrator could accidentally turn a public 2K/4K label into a
  // legacy generate-then-enhance plan without a real fulfillment recipe.
  const declaredResolutions = Array.isArray(obj.nativeResolutions)
    ? obj.nativeResolutions
    : Array.isArray(obj.resolutions)
      ? obj.resolutions.filter((resolution) => {
          const normalized = normalizeResolution(resolution);
          return normalized != null && resolutionHeight(normalized) <= 1080;
        })
      : [];
  const nativeResolutions = [...new Set(
    declaredResolutions
      .map((resolution) => normalizeResolution(resolution))
      .filter((resolution): resolution is ValidVideoResolution => Boolean(resolution && isValidVideoResolution(resolution))),
  )].sort((left, right) => resolutionHeight(left) - resolutionHeight(right));
  const normalizedMaxNative = normalizeResolution(obj.maxNativeResolution);
  const maxNative = normalizedMaxNative && isValidVideoResolution(normalizedMaxNative) ? normalizedMaxNative : null;
  return {
    resolutions: nativeResolutions.length > 0 ? nativeResolutions : undefined,
    nativeResolutions: nativeResolutions.length > 0 ? nativeResolutions : undefined,
    maxNativeResolution: maxNative,
  };
}

function isNativeResolution(requestedResolution: string | null, routeConfig: VideoRouteConfig | null | undefined): boolean {
  if (!requestedResolution) return false;
  const normalized = normalizeResolution(requestedResolution);
  if (!normalized) return false;
  if (routeConfig?.nativeResolutions?.length) {
    return routeConfig.nativeResolutions.includes(normalized);
  }
  if (routeConfig?.maxNativeResolution) {
    return resolutionHeight(normalized) <= resolutionHeight(routeConfig.maxNativeResolution);
  }
  return false;
}

function getVideoResolutionPlan(
  payload: Record<string, unknown>,
  routeConfig?: VideoRouteConfig | null,
  options: {
    allowTrustedSeedance25Native480p?: boolean;
    allowProviderNativeNonPublicResolution?: boolean;
  } = {},
): VideoResolutionPlan {
  const rawResolution = payload.resolution;
  const resolutionWasProvided = rawResolution !== undefined
    && rawResolution !== null
    && !(typeof rawResolution === "string" && rawResolution.trim() === "");
  // The public video API historically allowed callers to omit resolution.
  // Persist that request as the lowest supported public tier so the delivery
  // evidence contract never receives an unclassifiable null resolution.
  const requestedResolution =
    normalizeResolution(rawResolution) ?? (resolutionWasProvided ? null : "720p");
  if (resolutionWasProvided && (!requestedResolution || !isValidVideoResolution(requestedResolution))) {
    return {
      requestedResolution,
      generationResolution: null,
      finalResolution: null,
      needsEnhancement: false,
      invalidResolution: true,
    };
  }
  // Platform never sells 480p as a user/API deliverable. 480p remains valid only
  // as an internal generateResolution inside fulfillment recipes.
  const exactProviderNativeNonPublic = Boolean(
    options.allowProviderNativeNonPublicResolution
    && requestedResolution
    && ["480p", "768p", "960p"].includes(requestedResolution)
    && isNativeResolution(requestedResolution, routeConfig),
  );
  if (
    resolutionWasProvided
    && requestedResolution
    && !isPublicVideoResolution(requestedResolution)
    && !(requestedResolution === "480p" && options.allowTrustedSeedance25Native480p === true)
    && !exactProviderNativeNonPublic
  ) {
    return {
      requestedResolution,
      generationResolution: null,
      finalResolution: null,
      needsEnhancement: false,
      invalidResolution: true,
      publicResolutionForbidden: true,
    };
  }
  if (requestedResolution && routeConfig !== undefined && routeConfig !== null) {
    const native = isNativeResolution(requestedResolution, routeConfig);
    if (native) {
      return {
        requestedResolution,
        generationResolution: requestedResolution,
        finalResolution: requestedResolution,
        needsEnhancement: false,
      };
    }
    if (routeConfig.nativeResolutions?.length || routeConfig.maxNativeResolution) {
      const targetHeight = resolutionHeight(requestedResolution);
      const declaredNativeResolutions = [
        ...(routeConfig.nativeResolutions || []),
        ...(routeConfig.maxNativeResolution ? [routeConfig.maxNativeResolution] : []),
      ]
        .filter((resolution): resolution is string => isValidVideoResolution(resolution))
        .sort((left, right) => resolutionHeight(left) - resolutionHeight(right));
      const fallback = declaredNativeResolutions
        .filter((resolution) => resolutionHeight(resolution) < targetHeight)
        .at(-1) || "480p";
      const needsEnhancement = fallback !== requestedResolution;
      return {
        requestedResolution,
        generationResolution: fallback,
        finalResolution: requestedResolution,
        needsEnhancement,
      };
    }
  }
  // Legacy fallback when no route capability / recipe is declared: generate at
  // 720p then enhance for any public tier above 720p. Prefer recipes when present.
  // (480p remains valid only as a recipe-internal generateResolution, never as
  // the legacy public fallback floor.)
  const height = resolutionHeight(requestedResolution);
  const needsEnhancement = height > 720;
  return {
    requestedResolution,
    generationResolution: needsEnhancement ? "720p" : requestedResolution,
    finalResolution: requestedResolution,
    needsEnhancement,
  };
}

function createProviderNativeDeliveryAuthorization(input: {
  channel: RelayChannel | null;
  model: unknown;
  plan: VideoResolutionPlan | null;
}): ProviderNativeDeliveryAuthorization | null {
  const { channel, model, plan } = input;
  const resolution = plan?.requestedResolution;
  if (
    !channel
    || !((channel.provider === "minimax" && isMiniMaxH3Model(model) && resolution !== "960p")
      || (channel.provider === "autodl" && autoDLH3SupportsResolution(model, resolution)))
    || (resolution !== "480p" && resolution !== "768p" && resolution !== "960p")
    || plan?.generationResolution !== resolution
    || plan.finalResolution !== resolution
    || plan.needsEnhancement
    || !isNativeResolution(resolution, channel.routeConfig)
  ) {
    return null;
  }
  return {
    version: PROVIDER_NATIVE_DELIVERY_AUTHORIZATION_VERSION,
    provider: channel.provider as ProviderNativeDeliveryAuthorization["provider"],
    model: model as ProviderNativeDeliveryAuthorization["model"],
    channelId: channel.id,
    resolution,
  };
}

function restoreVideoResolutionPlanFromInternal(resultPayload: Record<string, unknown>, requestPayload: Record<string, unknown>): VideoResolutionPlan {
  const internal = resultPayload.internal;
  if (internal && typeof internal === "object" && !Array.isArray(internal)) {
    const i = internal as Record<string, unknown>;
    if (typeof i.requestedResolution === "string" || i.requestedResolution === null) {
      const requestedResolution = normalizeResolution(i.requestedResolution);
      const generationResolution = normalizeResolution(i.generationResolution);
      const finalResolution = normalizeResolution(i.finalResolution);
      const validRequested = requestedResolution === null || isValidVideoResolution(requestedResolution);
      const validGeneration = generationResolution === null || isValidVideoResolution(generationResolution);
      const validFinal = finalResolution === null || isValidVideoResolution(finalResolution);
      if (validRequested && validGeneration && validFinal && typeof i.needsTargetProcessing === "boolean") {
        const providerNativeDeliveryAuthorization =
          readProviderNativeDeliveryAuthorization(i.providerNativeDeliveryAuthorization);
        return {
          requestedResolution,
          generationResolution,
          finalResolution,
          needsEnhancement: i.needsTargetProcessing,
          recipeId: i.recipeId == null ? null : String(i.recipeId),
          enhanceChannelId: i.enhanceChannelId == null ? null : String(i.enhanceChannelId),
          upstreamModel: i.upstreamModel == null ? null : String(i.upstreamModel),
          attempts: parseVideoRecipeAttempts(i.attempts),
          ...(providerNativeDeliveryAuthorization
            ? { providerNativeDeliveryAuthorization }
            : {}),
        };
      }
    }
  }
  return getVideoResolutionPlan(requestPayload);
}

function parseVideoRecipeAttempts(raw: unknown): VideoRecipeAttempt[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const attempts = raw.slice(0, 50).map((item): VideoRecipeAttempt => {
    const record = item && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : {};
    return {
      recipeId: record.recipeId == null ? null : String(record.recipeId),
      channelId: record.channelId == null ? null : String(record.channelId),
      outcome: String(record.outcome || "unknown"),
      ...(record.message ? { message: String(record.message).slice(0, 500) } : {}),
      at: Number(record.at || 0),
    };
  });
  return attempts.length ? attempts : undefined;
}

function buildVideoInternalPlan(
  plan: VideoResolutionPlan,
  previousInternal?: unknown,
): Record<string, unknown> {
  const previous =
    previousInternal && typeof previousInternal === "object" && !Array.isArray(previousInternal)
      ? previousInternal as Record<string, unknown>
      : null;
  const deliverySourceEvidence = readRelaySourceEvidenceDescriptor(
    previous?.deliverySourceEvidence,
  );
  const canonicalVideoGeneration = parseJsonObject(
    previous?.canonicalVideoGeneration,
  );
  const videoAssetPolicyEvidence = parseJsonObject(
    previous?.videoAssetPolicyEvidence,
  );
  const videoProviderAdapter = parseJsonObject(
    previous?.videoProviderAdapter,
  );
  const seedance25CertificationProbe = parseJsonObject(
    previous?.seedance25CertificationProbe,
  );
  // This is server-owned durable authority. Provider responses are never used
  // as `previousInternal`; every rewrite must carry forward the exact binding
  // from the persisted Relay row or fail closed when that checkpoint is
  // malformed. This keeps accepted/poll/enhancement/final/failover paths wired
  // to their billing transaction hooks after resultPayload replacement.
  const privateValidationBudget = privateValidationBudgetFromInternal(previous);
  const privateValidationBudgetPricingCheckpoint =
    privateValidationBudgetPricingCheckpointFromInternal(previous);
  const providerNativeDeliveryAuthorization =
    readProviderNativeDeliveryAuthorization(plan.providerNativeDeliveryAuthorization);
  let structuredTimeline: StructuredTimelineRelayContext | null = null;
  if (previous?.structuredTimeline != null) {
    try {
      structuredTimeline = parseStructuredTimelineRelayContext(
        previous.structuredTimeline,
      );
    } catch {
      throw canonicalVideoBindingError(
        "structured_timeline_checkpoint_invalid",
        "Relay 内部的 30 秒时间线绑定已损坏",
      );
    }
  }
  return {
    requestedResolution: plan.requestedResolution,
    ...(previous?.arkVideoProtocol ? { arkVideoProtocol: previous.arkVideoProtocol } : {}),
    ...(previous?.portraitPreparation ? { portraitPreparation: previous.portraitPreparation } : {}),
    generationResolution: plan.generationResolution,
    finalResolution: plan.finalResolution,
    needsTargetProcessing: plan.needsEnhancement,
    pipeline: plan.needsEnhancement
      ? (plan.recipeId ? "generate_then_enhance" : "generate_then_target_quality")
      : "direct_generation",
    ...(plan.recipeId ? { recipeId: plan.recipeId } : {}),
    ...(plan.enhanceChannelId ? { enhanceChannelId: plan.enhanceChannelId } : {}),
    ...(plan.upstreamModel ? { upstreamModel: plan.upstreamModel } : {}),
    ...(plan.attempts && plan.attempts.length ? { attempts: plan.attempts } : {}),
    ...(providerNativeDeliveryAuthorization
      && !plan.needsEnhancement
      && plan.requestedResolution === providerNativeDeliveryAuthorization.resolution
      && plan.generationResolution === providerNativeDeliveryAuthorization.resolution
      && plan.finalResolution === providerNativeDeliveryAuthorization.resolution
      ? { providerNativeDeliveryAuthorization }
      : {}),
    ...(deliverySourceEvidence ? { deliverySourceEvidence } : {}),
    ...(Object.keys(canonicalVideoGeneration).length
      ? { canonicalVideoGeneration }
      : {}),
    ...(Object.keys(videoAssetPolicyEvidence).length
      ? { videoAssetPolicyEvidence }
      : {}),
    ...(Object.keys(videoProviderAdapter).length
      ? { videoProviderAdapter }
      : {}),
    ...(Object.keys(seedance25CertificationProbe).length
      ? { seedance25CertificationProbe }
      : {}),
    ...(privateValidationBudget
      ? {
          [RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_RELAY_EVIDENCE_KEY]:
            privateValidationBudget,
        }
      : {}),
    ...(privateValidationBudgetPricingCheckpoint
      ? {
          [PRIVATE_VALIDATION_BUDGET_PRICING_CHECKPOINT_KEY]:
            privateValidationBudgetPricingCheckpoint,
        }
      : {}),
    ...(structuredTimeline ? { structuredTimeline } : {}),
  };
}

function videoPlanFromFulfillment(plan: FulfillmentPlan): VideoResolutionPlan {
  return {
    requestedResolution: plan.requestedResolution,
    generationResolution: plan.generationResolution,
    finalResolution: plan.finalResolution,
    needsEnhancement: plan.needsEnhancement,
    recipeId: plan.recipeId,
    enhanceChannelId: plan.enhanceChannelId,
    upstreamModel: plan.upstreamModel,
  };
}

async function selectChannelById(
  channelId: string,
  input: Pick<CreateRelayTaskInput, "endpointType" | "workspaceId" | "provider">,
): Promise<RelayChannel | null> {
  const id = String(channelId || "").trim();
  if (!id) return null;
  const query = db("o_provider_channel").where({
    id,
    endpointType: input.endpointType,
    disabled: 0,
  });
  applyScopeFilter(query, input.workspaceId);
  if (input.provider) query.andWhere("provider", input.provider);
  const row = await query.first();
  if (!row) return null;
  if (!(await channelHasCapacity(row))) return null;
  return parseRelayChannel(row);
}

function mergePersistedVideoPlan(task: RelayTask, patch: Record<string, unknown>): Record<string, unknown> {
  if (task.endpointType !== "video_generation") return patch;
  const plan = restoreVideoResolutionPlanFromInternal(task.resultPayload, task.requestPayload);
  return {
    ...task.resultPayload,
    ...patch,
    internal: buildVideoInternalPlan(plan, task.resultPayload.internal),
  };
}

function buildProviderRequestPayload(
  input: CreateRelayTaskInput,
  videoPlan?: VideoResolutionPlan | null,
  options: {
    allowedProviderAssetUris?: ReadonlySet<string>;
    canonicalRequest?: VideoGenerationRequest | null;
  } = {},
): Record<string, unknown> {
  let payload = { ...input.requestPayload };
  delete payload.workspaceId;
  delete payload.requestId;
  delete payload.projectId;
  delete payload.project_id;
  delete payload.provider;
  delete payload.callback_url;
  delete payload.callbackUrl;
  delete payload.callback_secret;
  delete payload.callbackSecret;
  delete payload.callback_secret_ciphertext;

  if (input.endpointType === "video_generation") {
    // `requestPayload.model` and task.model remain the public SKU for
    // idempotency, billing, and audit. A fulfillment recipe may map it to
    // `videoPlan.upstreamModel`; the provider boundary must use that dispatch
    // model on initial submit, worker recovery, and recipe failover. Falling
    // back to input.model keeps pre-migration queued tasks dispatchable.
    const providerModel = String(videoPlan?.upstreamModel || input.model || "").trim();
    if (providerModel) payload.model = providerModel;
    else delete payload.model;

    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    if ((!Array.isArray(payload.content) || payload.content.length === 0) && prompt.trim()) {
      payload.content = [{ type: "text", text: prompt }];
    }
    delete payload.prompt;

    if (payload.ratio === undefined && typeof payload.aspect_ratio === "string") {
      payload.ratio = payload.aspect_ratio;
    }
    delete payload.aspect_ratio;

    if (payload.generate_audio === undefined && typeof payload.audio === "boolean") {
      payload.generate_audio = payload.audio;
    }
    delete payload.audio;

    const plan = videoPlan || getVideoResolutionPlan(input.requestPayload);
    if (plan.generationResolution) payload.resolution = plan.generationResolution;
    else delete payload.resolution;

    // Apply the same reviewed field boundary to saved Worker requests. Only
    // the caller's validated canonical checkpoint may authorize operation fields.
    payload = projectControlledVideoProviderPayload(payload, {
      canonicalRequest: options.canonicalRequest,
    });
  }
  const idempotencyField = resolveProviderIdempotencyField(input);
  if (idempotencyField && input.requestId) payload[idempotencyField] = input.requestId;

  // Capability validation uses the internal `reference_role`, but ModelArk's
  // provider schema accepts only the official content fields. Normalize and
  // enforce payload limits before task persistence, billing reservation, or
  // any provider submission.
  return input.endpointType === "video_generation"
    ? normalizeAndValidateProviderVideoPayload(payload, {
        allowedProviderAssetUris: options.allowedProviderAssetUris,
      })
    : payload;
}

function resolveProviderIdempotencyField(input: Pick<CreateRelayTaskInput, "endpointType" | "provider">): string | null {
  const endpointKey = String(input.endpointType || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const providerKey = String(input.provider || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const raw =
    (providerKey && endpointKey ? process.env[`FANJIN_RELAY_${providerKey}_${endpointKey}_IDEMPOTENCY_FIELD`] : "") ||
    (endpointKey ? process.env[`FANJIN_RELAY_${endpointKey}_IDEMPOTENCY_FIELD`] : "") ||
    process.env.FANJIN_RELAY_PROVIDER_IDEMPOTENCY_FIELD ||
    "";
  const value = String(raw).trim();
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) ? value : null;
}

function extractProviderTaskId(payload: Record<string, unknown>): string | null {
  const value = pickFirst(payload, ["id", "task_id", "taskId", "data.id", "data.task_id", "data.taskId", "result.id"]);
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function extractVideoUrl(payload: Record<string, unknown>): string | null {
  const value =
    videoRelayProviderVideoUrl("minimax", payload)
    || videoRelayProviderVideoUrl("autodl", payload)
    || pickFirst(payload, [
      "content.video_url",
      "content.video.url",
      "video_url",
      "video.url",
      "output.video_url",
      "output.url",
      "data.content.video_url",
      "data.output.video_url",
      "data.output.url",
      "data.video_url",
      "data.url",
      "result.video_url",
      "result.url",
    ]) || (Array.isArray((payload as any).output) ? (payload as any).output[0]?.url || (payload as any).output[0]?.video_url : null);
  return value ? String(value) : null;
}

function redactRelayText(value: unknown): string {
  return redactSensitiveText(value)
    .replace(/([?&](?:x-amz-signature|signature|token|api[-_]?key|apikey|access[-_]?key|security-token|credential)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]+/gi, "$1?[REDACTED]");
}

function getResponseErrorMessage(payload: Record<string, unknown>, fallback: string): string {
  return redactRelayText(
    pickFirst(payload, ["error.message", "error", "message", "msg", "data.error.message", "data.message", "result.error.message"]) ||
      fallback,
  );
}

function resolveChannelTimeoutMs(channel?: Pick<RelayChannel, "timeoutMs" | "config"> | null): number {
  const configured = Number(channel?.config?.timeoutMs || channel?.timeoutMs || process.env.FANJIN_RELAY_PROVIDER_TIMEOUT_MS || 600000);
  return Number.isFinite(configured) && configured > 0 ? configured : 600000;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  assertProviderDispatchAllowed();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`Provider request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function relayCallbackUrl(task: RelayTask): string | null {
  const value = task.requestPayload.callback_url || task.requestPayload.callbackUrl;
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim();
}

async function dispatchRelayCallbackIfNeeded(task: RelayTask): Promise<RelayTask> {
  if (isRecoveryOnlyMode()) return task;
  const callbackUrl = relayCallbackUrl(task);
  if (!callbackUrl || !isTerminalStatus(task.status)) return task;

  const previous = (task.providerPayload.callback as Record<string, unknown> | undefined) || {};
  if (previous.deliveredAt && !(await getRelayCallbackDeliveryByTask(task.id))) return task;
  try {
    await enqueueRelayCallbackDelivery({
      taskId: task.id,
      callbackUrl,
      payload: await formatPublicRelayTask(task),
      secretCiphertext: typeof task.requestPayload.callback_secret_ciphertext === "string"
        ? task.requestPayload.callback_secret_ciphertext
        : null,
    });
    await processRelayCallbackDeliveryForTask({ taskId: task.id });
  } catch (err: any) {
    // 终态与计费不能被回调基础设施反向回滚。独立 worker 会扫描终态任务并修复漏入队记录。
    console.warn("[relay-callback] enqueue or immediate delivery failed", task.id, redactRelayText(err?.message || err));
  }
  return (await getRelayTask(task.id)) || task;
}

function resolveVideoEnhanceConfig(): VideoEnhanceConfig | null {
  // Formal candidate authorization currently covers the declared 720p/1080p
  // matrix only.  A future 2K/4K run must carry a separate video_upscale FD6
  // grant and operation lease; falling back to process-global enhancement
  // credentials would silently escape that signed scope.
  if (isFormalCandidateCredentialRuntimeDeclared()) return null;
  const mode = resolveVideoEnhanceMode();
  const submitEndpoint = process.env.VOLCANO_VIDEO_ENHANCE_ENDPOINT || DEFAULT_VIDEO_ENHANCE_SUBMIT_ENDPOINTS[mode];
  const statusEndpoint = process.env.VOLCANO_VIDEO_ENHANCE_STATUS_ENDPOINT || DEFAULT_VIDEO_ENHANCE_STATUS_ENDPOINT;
  const apiKey = process.env.VOLCANO_VIDEO_ENHANCE_API_KEY || process.env.VOLCANO_MEDIAKIT_API_KEY || "";
  if (!submitEndpoint || !apiKey) return null;
  return {
    submitEndpoint,
    statusEndpoint,
    apiKey,
    mode,
  };
}

/**
 * Use the exact recipe-bound media service. Legacy schema-52 deployments alone
 * can still resolve their deployment-wide configuration.
 */
async function resolveVideoEnhanceConfigForPlan(plan: VideoResolutionPlan): Promise<VideoEnhanceConfig | null> {
  if (isFormalCandidateCredentialRuntimeDeclared()) return null;
  const enhanceChannelId = String(plan.enhanceChannelId || "").trim();
  if (enhanceChannelId) {
    const row = await findMediaService(db as any, enhanceChannelId, "mediakit");
    // An explicitly bound service must never escape to a different credential.
    return mediaKitRuntimeConfig(row, String(plan.finalResolution || plan.requestedResolution || ""));
  }
  if (await mediaServiceTable(db as any) === MEDIA_SERVICE_TABLE) {
    return null;
  }
  return resolveVideoEnhanceConfig();
}

function cleanEnhanceEndpoint(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function buildVideoEnhanceRequestPayload(input: { taskId: string; sourceUrl: string; plan: VideoResolutionPlan }): Record<string, unknown> {
  const body: Record<string, unknown> = {
    video_url: input.sourceUrl,
    resolution: input.plan.finalResolution,
  };
  const scene = process.env.VOLCANO_VIDEO_ENHANCE_SCENE;
  const toolVersion = process.env.VOLCANO_VIDEO_ENHANCE_TOOL_VERSION;
  const fps = optionalNumber(process.env.VOLCANO_VIDEO_ENHANCE_FPS);
  const bitrateLevel = process.env.VOLCANO_VIDEO_ENHANCE_BITRATE_LEVEL;
  if (scene) body.scene = scene;
  if (toolVersion) body.tool_version = toolVersion;
  if (fps !== undefined) body.fps = fps;
  if (bitrateLevel) body.bitrate_level = bitrateLevel;
  if (process.env.VOLCANO_VIDEO_ENHANCE_CLIENT_TOKEN === "task_id") body.client_token = input.taskId;
  return body;
}

function relayMediaMaximumBytes(): number {
  const configured = Number(
    process.env.FANJIN_RELAY_MEDIA_MAX_BYTES
      || 512 * 1024 * 1024,
  );
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : 512 * 1024 * 1024;
}

function relayMediaDownloadTimeoutMs(): number {
  const configured = Number(
    process.env.FANJIN_RELAY_MEDIA_DOWNLOAD_TIMEOUT_MS || 600_000,
  );
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : 600_000;
}

function relayVideoExtension(mimeType: string): string {
  if (mimeType === "video/mp4") return "mp4";
  if (mimeType === "video/webm") return "webm";
  if (mimeType === "video/quicktime") return "mov";
  if (mimeType === "video/x-matroska") return "mkv";
  if (mimeType === "video/mpeg") return "mpeg";
  throw new Error("unsupported relay video MIME type");
}

interface MirroredRelayVideo {
  url: string;
  localPath: string | null;
  storageKey: string | null;
  writeIntentClaim: ObjectWriteIntentClaim | null;
  mirrored: boolean;
  mimeType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  videoCodec: string | null;
  bitrateBps: number | null;
  audioTrackCount: number | null;
  audioCodecs: string[] | null;
  contentLengthBytes: number | null;
  contentSha256: string | null;
}

async function mirrorFinalVideoToServer(
  taskId: string,
  workspaceId: string,
  projectId: number,
  url: string,
  database: Knex,
  testHooks?: SafeRemoteVideoDownloadTestHooks,
): Promise<MirroredRelayVideo> {
  const taskKey = crypto
    .createHash("sha256")
    .update(taskId)
    .digest("hex");
  let safeMirror: Awaited<ReturnType<typeof mirrorVideoToOwnedStorage>> | null = null;
  try {
    const downloaded = testHooks
      ? await downloadPublicRemoteVideo({
          url,
          maximumBytes: relayMediaMaximumBytes(),
          timeoutMs: relayMediaDownloadTimeoutMs(),
          maximumRedirects: 3,
          testHooks,
        })
      : await (async () => {
          // Preserve the public REMOTE_VIDEO_* validation contract before
          // the local mirroring/probing layer applies its own SSRF checks.
          // Local integration providers opt in through the existing explicit
          // test-only mirror switch. Production and ordinary tests still pass
          // through the independent public-address validator.
          const privateTestMirrorEnabled = process.env.NODE_ENV === "test"
            && process.env.FANJIN_TEST_ALLOW_PRIVATE_MEDIA_URLS === "1";
          if (!privateTestMirrorEnabled) {
            await validatePublicRemoteVideoUrl({
              url,
              timeoutMs: relayMediaDownloadTimeoutMs(),
            });
          }
          safeMirror = await mirrorVideoToOwnedStorage(taskId, url);
          if (!safeMirror.localPath || !safeMirror.contentSha256) {
            throw new Error("safe video mirror did not retain a verified file");
          }
          return {
            body: await fs.promises.readFile(safeMirror.localPath),
            mimeType: safeMirror.mimeType,
          };
        })();
    // Content-address the mirrored result. A retry that returns different
    // bytes must never overwrite the URL currently referenced by the
    // database before the replacement transaction commits. The project
    // namespace still lets deletion enumerate every historical generation.
    const contentHash = crypto
      .createHash("sha256")
      .update(downloaded.body)
      .digest("hex");
    // Assignment happens inside the downloader closure, which TypeScript's
    // control-flow analysis cannot observe across the await boundary.
    const persistedProbe = safeMirror as Awaited<
      ReturnType<typeof mirrorVideoToOwnedStorage>
    > | null;
    if (
      persistedProbe?.contentSha256
      && persistedProbe.contentSha256 !== contentHash
    ) {
      throw new Error("safe video mirror bytes changed after verification");
    }
    const extension = relayVideoExtension(downloaded.mimeType);
    const durable = await writeObjectWithDurableIntent({
      purpose: "relay_final",
      workspaceId,
      projectId,
      body: downloaded.body,
      contentSha256: contentHash,
      storageKey: (intentId) =>
        `${projectId}/relay/${taskKey}/${contentHash}/${intentId}.${extension}`,
      writerIdPrefix: "relay-final",
    }, {
      database,
      writer: u.oss,
    });
    const durableLocalPath = durable.receipt === null
      ? resolveOwnedVideoStorageKeyLocalPath(
          durable.url,
          durable.storageKey,
          durable.storageKey,
        )
      : null;
    if (durable.receipt === null && !durableLocalPath) {
      throw new Error("durable local relay object does not resolve to its owned file");
    }
    return {
      url: durable.url,
      localPath: durableLocalPath,
      storageKey: durable.storageKey,
      writeIntentClaim: durable.claim,
      mirrored: true,
      mimeType: downloaded.mimeType,
      width: persistedProbe?.width ?? null,
      height: persistedProbe?.height ?? null,
      durationMs: persistedProbe?.durationMs ?? null,
      videoCodec: persistedProbe?.videoCodec ?? null,
      bitrateBps: persistedProbe?.bitrateBps ?? null,
      audioTrackCount: persistedProbe?.audioTrackCount ?? null,
      audioCodecs: persistedProbe?.audioCodecs
        ? [...persistedProbe.audioCodecs]
        : null,
      contentLengthBytes: persistedProbe?.contentLengthBytes ?? null,
      contentSha256: persistedProbe?.contentSha256 ?? contentHash,
    };
  } catch (err) {
    console.warn("[relay-video] final media persistence failed", taskId, {
      code: String((err as any)?.code || "MEDIA_PERSISTENCE_ERROR"),
      message: redactRelayText((err as any)?.message || String(err)),
      cause: redactRelayText((err as any)?.cause?.message || ""),
      causeCode: String((err as any)?.cause?.code || ""),
    });
    if (String((err as any)?.code || "").startsWith("REMOTE_VIDEO_")) {
      throw err;
    }
    const error: any = new Error(
      "relay final media could not be persisted with a durable write intent",
    );
    error.code = "relay_final_media_persistence_failed";
    error.cause = err;
    throw error;
  } finally {
    if (safeMirror) removeMirroredVideo(safeMirror);
  }
}

// ─── REVAMP-PLAN 1.6 二期:relay 视频终态资产入库 ────────────────────────────
// 与图片链路(generation.ts execute / images.ts:498)对齐:终态视频在写
// o_media_asset(source=relay_final)的同时写 o_assets + o_image(产出
// assetVersionId = o_image.id),并把 assetId/assetVersionId 回填进
// o_media_asset.metadata。项目归属只接受 o_relay_task.projectId /
// workspaceId，绝不从 requestId、URL 或调用方参数推断。没有 projectId
// 的通用 Relay 任务只能创建工作区级媒体记录，不能伪造项目资产关系。

export interface FinalVideoAssetIdentity {
  taskId: string;
}

interface RelayFinalAssetAuthority {
  taskId: string;
  workspaceId: string;
  projectId: number | null;
  requestId: string | null;
  prompt: string | null;
  model: string | null;
  actorUserId: number | null;
}

function relayFinalAssetError(
  code: string,
  message: string,
): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function videoPromptFromRequestPayload(requestPayload: Record<string, unknown> | null | undefined): string | null {
  const content = Array.isArray(requestPayload?.content) ? requestPayload.content : [];
  for (const item of content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const part = item as Record<string, unknown>;
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) return part.text.trim();
  }
  if (typeof requestPayload?.prompt === "string" && requestPayload.prompt.trim()) {
    return requestPayload.prompt.trim();
  }
  return null;
}

async function resolveRelayFinalAssetAuthority(
  client: Knex | Knex.Transaction,
  taskId: string,
  options: { lock?: boolean } = {},
): Promise<RelayFinalAssetAuthority> {
  const initialTask = await client("o_relay_task")
    .where({ id: taskId, endpointType: "video_generation" })
    .select(
      "id",
      "workspaceId",
      "projectId",
      "requestId",
      "requestPayload",
      "model",
      "providerPayload",
    )
    .first();
  if (!initialTask) {
    throw relayFinalAssetError(
      "relay_final_task_not_found",
      "relay final media task does not exist",
    );
  }
  const workspaceId = String(initialTask.workspaceId || "").trim();
  const projectId = initialTask.projectId == null
    ? null
    : Number(initialTask.projectId);
  if (!workspaceId || (
    projectId !== null
    && (!Number.isSafeInteger(projectId) || projectId <= 0)
  )) {
    throw relayFinalAssetError(
      "relay_final_task_ownership_invalid",
      "relay final media task has invalid authoritative ownership",
    );
  }

  if (projectId !== null) {
    let projectQuery = client("o_project")
      .where({ id: projectId })
      .select("id", "workspaceId", "deletionState", "userId");
    if (options.lock) projectQuery = projectQuery.forUpdate();
    const project = await projectQuery.first();
    if (
      !project
      || String(project.workspaceId || "") !== workspaceId
    ) {
      throw relayFinalAssetError(
        "relay_final_task_workspace_mismatch",
        "relay final media task does not match its project workspace",
      );
    }
    if (String(project.deletionState || "") !== "active") {
      throw relayFinalAssetError(
        "relay_final_project_not_active",
        "relay final media project is not active",
      );
    }
  }

  const initialIdentity = parseJsonObject(parseJsonObject(initialTask.providerPayload).identity);
  const persistedActorUserId = Number(initialIdentity?.actorUserId || 0);

  let task = initialTask;
  if (options.lock) {
    task = await client("o_relay_task")
      .where({ id: taskId, endpointType: "video_generation" })
      .select(
        "id",
        "workspaceId",
        "projectId",
        "requestId",
        "requestPayload",
        "model",
      )
      .forUpdate()
      .first();
    if (
      !task
      || (task.projectId == null ? null : Number(task.projectId)) !== projectId
      || String(task.workspaceId || "").trim() !== workspaceId
    ) {
      throw relayFinalAssetError(
        "relay_final_task_ownership_changed",
        "relay final media task ownership changed during finalization",
      );
    }
  }

  return {
    taskId: String(task.id),
    workspaceId,
    projectId,
    requestId: task.requestId == null ? null : String(task.requestId),
    prompt: videoPromptFromRequestPayload(
      parseJsonObject(task.requestPayload),
    ),
    model: task.model == null ? null : String(task.model),
    actorUserId: Number.isSafeInteger(persistedActorUserId)
      && persistedActorUserId > 0
      ? persistedActorUserId
      : null,
  };
}

function readVideoAssetLink(metadata: unknown): { assetId: number; assetVersionId: number; assetOrigin?: string } | null {
  const parsed = parseJsonObject(typeof metadata === "string" ? metadata : stringifyJson(metadata ?? {}));
  const assetId = Number(parsed.assetId);
  const assetVersionId = Number(parsed.assetVersionId);
  if (!Number.isSafeInteger(assetId) || assetId <= 0) return null;
  if (!Number.isSafeInteger(assetVersionId) || assetVersionId <= 0) return null;
  const assetOrigin = typeof parsed.assetOrigin === "string" && parsed.assetOrigin ? parsed.assetOrigin : undefined;
  return { assetId, assetVersionId, ...(assetOrigin ? { assetOrigin } : {}) };
}

async function writebackRelayVideoAssetVersion(input: {
  transaction: Knex.Transaction;
  authority: RelayFinalAssetAuthority & { projectId: number };
  url: string;
  storageKey: string | null;
  metadata: Record<string, unknown>;
  now: number;
}): Promise<{ assetId: number; assetVersionId: number }> {
  const prompt = String(input.authority.prompt || "").trim();
  const resolution = String(input.metadata.finalResolution || input.metadata.requestedResolution || "").trim() || null;
  const assetId = await insertAndReturnId(input.transaction, "o_assets", {
    type: "clip",
    projectId: input.authority.projectId,
    name: (prompt || "生成视频").slice(0, 80),
    prompt: prompt || null,
    startTime: input.now,
  });
  const assetVersionId = await insertAndReturnId(
    input.transaction,
    "o_image",
    {
      filePath: input.storageKey ?? input.url,
      storageKey: input.storageKey,
      type: "clip",
      assetsId: assetId,
      model: input.authority.model,
      resolution,
      state: "已完成",
    },
  );
  await input.transaction("o_assets")
    .where({ id: assetId })
    .update({ imageId: assetVersionId });
  return { assetId, assetVersionId };
}

interface StoredRelayFinalVideoAsset {
  assetId: string;
  url: string;
}

type RelayFinalAssetMetadataFactory = (
  stored: StoredRelayFinalVideoAsset,
) => Record<string, unknown>;

async function storeOrUpdateFinalVideoAssetWithId(
  identity: FinalVideoAssetIdentity,
  url: string,
  metadata: Record<string, unknown>,
  metadataFactory?: RelayFinalAssetMetadataFactory,
  fence?: RelayFinalizationFence,
  database: Knex = db,
  mediaDownloadTestHooks?: SafeRemoteVideoDownloadTestHooks,
): Promise<StoredRelayFinalVideoAsset | null> {
  const initialAuthority = await resolveRelayFinalAssetAuthority(
    database,
    identity.taskId,
  );
  if (initialAuthority.projectId === null && !metadataFactory) {
    await validatePublicRemoteVideoUrl({
      url,
      timeoutMs: relayMediaDownloadTimeoutMs(),
      testHooks: mediaDownloadTestHooks,
    });
    return null;
  }

  const now = Date.now();
  const mirrored: MirroredRelayVideo = initialAuthority.projectId === null
    ? await (async () => {
        const owned = await mirrorVideoToOwnedStorage(identity.taskId, url);
        return {
          url: owned.url,
          localPath: owned.localPath,
          storageKey: null,
          writeIntentClaim: null,
          mirrored: owned.mirrored,
          mimeType: owned.mimeType,
          width: owned.width,
          height: owned.height,
          durationMs: owned.durationMs,
          videoCodec: owned.videoCodec,
          bitrateBps: owned.bitrateBps,
          audioTrackCount: owned.audioTrackCount,
          audioCodecs: owned.audioCodecs ? [...owned.audioCodecs] : null,
          contentLengthBytes: owned.contentLengthBytes,
          contentSha256: owned.contentSha256,
        };
      })()
    : await mirrorFinalVideoToServer(
        identity.taskId,
        initialAuthority.workspaceId,
        initialAuthority.projectId,
        url,
        database,
        mediaDownloadTestHooks,
      );
  const assetUrl = mirrored.url;
  const deliveryProof = createRelayVideoDeliveryProof(mirrored);
  const baseMetadata = {
    ...metadata,
    mirrored: mirrored.mirrored,
    mediaProbe: mirrored.width && mirrored.height && mirrored.durationMs && mirrored.contentSha256
      ? {
          version: "relay-video-media-probe/v1",
          width: mirrored.width,
          height: mirrored.height,
          durationMs: mirrored.durationMs,
          mimeType: mirrored.mimeType,
          contentSha256: mirrored.contentSha256,
        }
      : null,
    // This proof exists only after the server has downloaded the provider
    // result, ffprobed its actual streams and persisted the verified bytes.
    deliveryProof,
  };
  let storedMediaAssetId: string | null = null;
  let storedProjectAssetLink: { assetId: number; assetVersionId: number } | null = null;
  try {
    await database.transaction(async (trx) => {
      const authority = await resolveRelayFinalAssetAuthority(
        trx,
        identity.taskId,
        { lock: true },
      );
      if (
        authority.projectId !== initialAuthority.projectId
        || authority.workspaceId !== initialAuthority.workspaceId
      ) {
        throw relayFinalAssetError(
          "relay_final_task_ownership_changed",
          "relay final media task ownership changed during mirroring",
        );
      }
      let lockedTask: Record<string, any> | null = null;
      if (metadataFactory) {
        let taskQuery = trx("o_relay_task")
          .where({ id: identity.taskId, endpointType: "video_generation" })
          .select(
            "id",
            "workspaceId",
            "projectId",
            "channelId",
            "providerTaskId",
            "status",
            "leaseOwner",
            "leaseExpiresAt",
            "resultPayload",
          );
        if (isPostgresClient(trx)) taskQuery = taskQuery.forUpdate();
        lockedTask = await taskQuery.first() || null;
        const lockedProjectId = lockedTask?.projectId == null
          ? null
          : Number(lockedTask.projectId);
        if (
          !lockedTask
          || !fence
          || !fence.leaseOwner
          || String(lockedTask.workspaceId || "") !== authority.workspaceId
          || lockedProjectId !== authority.projectId
          || String(lockedTask.leaseOwner || "") !== fence.leaseOwner
          || Number(lockedTask.leaseExpiresAt || 0) <= Date.now()
          || String(lockedTask.providerTaskId || identity.taskId) !== fence.providerTaskId
          || !["running", "enhancing"].includes(String(lockedTask.status || ""))
        ) {
          throw new RelayFinalizationFenceError();
        }
      }

      const existingRows = await trx("o_media_asset")
        .where({
          taskId: authority.taskId,
          source: "relay_final",
        })
        .select("*")
        .forUpdate();
      if (existingRows.length > 1) {
        throw relayFinalAssetError(
          "relay_final_media_duplicate",
          "relay final media has duplicate persistent assets",
        );
      }
      const existing = existingRows[0];
      if (
        existing
        && (
          (existing.projectId == null ? null : Number(existing.projectId))
            !== authority.projectId
          || String(existing.workspaceId || "") !== authority.workspaceId
        )
      ) {
        throw relayFinalAssetError(
          "relay_final_media_ownership_mismatch",
          "relay final media ownership conflicts with its task",
        );
      }
      const referencedMediaId = existing ? String(existing.id) : uuid();
      storedMediaAssetId = referencedMediaId;
      const evidenceMetadata = metadataFactory?.({
        assetId: referencedMediaId,
        url: assetUrl,
      }) ?? {};
      if (metadataFactory) {
        const finalEvidence = readRelayFinalEvidenceDescriptor(
          evidenceMetadata.deliveryFinalEvidence,
        );
        const lockedChannelId = String(lockedTask?.channelId || "");
        const lockedGenerationAttemptId = String(
          lockedTask?.providerTaskId || identity.taskId,
        );
        const expectedAttemptId = createRelaySourceEvidenceDescriptor({
          taskId: identity.taskId,
          channelId: lockedChannelId,
          generationAttemptId: lockedGenerationAttemptId,
          sourceUrl: assetUrl,
          resolution: finalEvidence?.resolution || "",
        }).attemptId;
        if (
          !finalEvidence
          || finalEvidence.taskId !== identity.taskId
          || finalEvidence.channelId !== lockedChannelId
          || finalEvidence.generationAttemptId !== expectedAttemptId
          || finalEvidence.assetId !== referencedMediaId
        ) {
          throw relayFinalAssetError(
            "relay_final_evidence_invalid",
            "relay final asset evidence does not match the authoritative task",
          );
        }
        const lockedStatus = String(lockedTask?.status || "");
        if (lockedStatus === "failed" || lockedStatus === "cancelled") {
          throw relayFinalAssetError(
            "relay_final_terminal_conflict",
            "relay final asset arrived after a conflicting terminal state",
          );
        }
        if (lockedStatus === "succeeded") {
          const lockedResult = parseJsonObject(lockedTask?.resultPayload);
          const lockedInternal = parseJsonObject(lockedResult.internal);
          const lockedEvidence = readRelayFinalEvidenceDescriptor(
            lockedInternal.deliveryFinalEvidence,
          );
          if (JSON.stringify(lockedEvidence) !== JSON.stringify(finalEvidence)) {
            throw relayFinalAssetError(
              "relay_final_terminal_winner_conflict",
              "relay final asset cannot replace the terminal winner",
            );
          }
        }
      }

      let link = existing ? readVideoAssetLink(existing.metadata) : null;
      if (authority.projectId === null && link) {
        throw relayFinalAssetError(
          "relay_final_workspace_asset_link_invalid",
          "workspace-scoped relay media cannot reference a project asset",
        );
      }
      if (link && authority.projectId !== null) {
        const linkedAsset = await trx("o_assets")
          .where({
            id: link.assetId,
            projectId: authority.projectId,
          })
          .first();
        const linkedVersion = await trx("o_image")
          .where({
            id: link.assetVersionId,
            assetsId: link.assetId,
          })
          .first();
        if (!linkedAsset || !linkedVersion) {
          throw relayFinalAssetError(
            "relay_final_media_link_invalid",
            "relay final media link is not owned by its task project",
          );
        }
        await trx("o_image")
          .where({ id: link.assetVersionId })
          .update({
            filePath: mirrored.storageKey ?? assetUrl,
            storageKey: mirrored.storageKey,
            model: authority.model,
            resolution: String(
              metadata.finalResolution
                || metadata.requestedResolution
                || "",
            ).trim() || null,
          });
      } else if (authority.projectId !== null) {
        link = await writebackRelayVideoAssetVersion({
          transaction: trx,
          authority: {
            ...authority,
            projectId: authority.projectId,
          },
          url: assetUrl,
          storageKey: mirrored.storageKey,
          metadata: baseMetadata,
          now,
        });
      }
      storedProjectAssetLink = link;
      if (link && authority.projectId !== null && authority.actorUserId !== null) {
        await registerAccountOwnedAssetIfAvailable({
          transaction: trx,
          assetId: link.assetId,
          projectId: authority.projectId,
          workspaceId: authority.workspaceId,
          actorUserId: authority.actorUserId,
          assetVersionId: `image:${link.assetVersionId}`,
          idempotencyKey: `relay-final:${authority.taskId}:${link.assetId}:ownership`,
          now,
        });
      }

      const persistedMetadata = stringifyJson({
        ...baseMetadata,
        ...evidenceMetadata,
        ...(link
          ? {
              assetId: link.assetId,
              assetVersionId: link.assetVersionId,
            }
          : {}),
        assetOrigin: "relay_task",
      });
      if (existing) {
        await trx("o_media_asset")
          .where({ id: existing.id })
          .update({
            workspaceId: authority.workspaceId,
            projectId: authority.projectId,
            url: assetUrl,
            localPath: mirrored.localPath,
            storageKey: mirrored.storageKey,
            mimeType: mirrored.mimeType,
            width: mirrored.width,
            height: mirrored.height,
            durationMs: mirrored.durationMs,
            metadata: persistedMetadata,
            createTime: now,
          });
      } else {
        await trx("o_media_asset").insert({
          id: referencedMediaId,
          taskId: authority.taskId,
          workspaceId: authority.workspaceId,
          projectId: authority.projectId,
          assetType: "video",
          source: "relay_final",
          url: assetUrl,
          localPath: mirrored.localPath,
          storageKey: mirrored.storageKey,
          mimeType: mirrored.mimeType,
          width: mirrored.width,
          height: mirrored.height,
          durationMs: mirrored.durationMs,
          metadata: persistedMetadata,
          createTime: now,
        });
      }
      if (metadataFactory && lockedTask) {
        const lockedResult = parseJsonObject(lockedTask.resultPayload);
        const lockedInternal = parseJsonObject(lockedResult.internal);
        const finalEvidence = readRelayFinalEvidenceDescriptor(
          evidenceMetadata.deliveryFinalEvidence,
        );
        const sourceEvidence = readRelaySourceEvidenceDescriptor(
          evidenceMetadata.deliverySourceEvidence,
        );
        const evidenceUpdated = await trx("o_relay_task")
          .where({
            id: identity.taskId,
            leaseOwner: fence!.leaseOwner,
          })
          .update({
            resultPayload: stringifyJson({
              ...lockedResult,
              internal: {
                ...lockedInternal,
                ...(sourceEvidence
                  ? { deliverySourceEvidence: sourceEvidence }
                  : {}),
                ...(finalEvidence
                  ? { deliveryFinalEvidence: finalEvidence }
                  : {}),
              },
            }),
          });
        if (Number(evidenceUpdated) !== 1) {
          throw new RelayFinalizationFenceError();
        }
      }
      if (mirrored.writeIntentClaim && mirrored.storageKey) {
        if (authority.projectId === null) {
          throw relayFinalAssetError(
            "relay_final_write_intent_scope_invalid",
            "workspace-scoped relay media cannot claim a project object write",
          );
        }
        await commitObjectWriteIntentInTransaction(
          trx,
          mirrored.writeIntentClaim,
          createObjectWriteMediaReferenceEvidence({
            rowId: referencedMediaId,
            workspaceId: authority.workspaceId,
            projectId: authority.projectId,
            storageKey: mirrored.storageKey,
            publicUrl: assetUrl,
          }),
        );
      }
    });
  } catch (error) {
    if (mirrored.writeIntentClaim) {
      try {
        await queueDurableObjectWriteCompensation(
          mirrored.writeIntentClaim,
          error,
          { database },
        );
      } catch (queueError) {
        const failure: any = new AggregateError(
          [error, queueError],
          "relay final media DB write failed and durable compensation could not be queued",
        );
        failure.code = "relay_final_media_compensation_queue_failed";
        failure.cause = error;
        failure.queueCause = queueError;
        throw failure;
      }
    } else if (
      initialAuthority.projectId === null
      && mirrored.mirrored
      && mirrored.localPath
    ) {
      fs.rmSync(mirrored.localPath, { force: true });
    }
    throw error;
  }
  if (storedProjectAssetLink) {
    await notifyAgentVideoGenerationTaskTerminal({
      database,
      taskId: initialAuthority.taskId,
      requestId: initialAuthority.requestId,
      workspaceId: initialAuthority.workspaceId,
      outcome: "succeeded",
      assetLink: storedProjectAssetLink,
      now,
    }).catch(() => undefined);
  }
  return storedMediaAssetId
    ? { assetId: storedMediaAssetId, url: assetUrl }
    : null;
}

export async function storeOrUpdateFinalVideoAsset(
  identity: FinalVideoAssetIdentity,
  url: string,
  metadata: Record<string, unknown>,
  database: Knex = db,
  mediaDownloadTestHooks?: SafeRemoteVideoDownloadTestHooks,
): Promise<void> {
  await storeOrUpdateFinalVideoAssetWithId(
    identity,
    url,
    metadata,
    undefined,
    undefined,
    database,
    mediaDownloadTestHooks,
  );
}

function finalVideoAssetIdentity(input: {
  taskId: string;
  workspaceId?: string | null;
  requestId?: string | null;
  prompt?: string | null;
  model?: string | null;
}): FinalVideoAssetIdentity {
  return {
    taskId: input.taskId,
  };
}

async function fallbackToGeneratedVideo(input: {
  taskId: string;
  channelId: string;
  generationAttemptId: string;
  leaseOwner: string;
  workspaceId: string | null;
  requestId: string | null;
  prompt: string | null;
  model: string | null;
  sourceUrl: string;
  plan: VideoResolutionPlan;
  payload: Record<string, unknown>;
  persistedResultPayload: Record<string, unknown>;
  reason: string;
  enhancementPayload?: Record<string, unknown>;
}): Promise<{ status: RelayTaskStatus; resultPayload: Record<string, unknown>; errorMessage: string | null }> {
  const fallbackResolution = input.plan.generationResolution || input.plan.finalResolution || input.plan.requestedResolution;
  let deliverySourceEvidence = null as ReturnType<typeof createRelaySourceEvidenceDescriptor> | null;
  let deliveryFinalEvidence: RelayFinalEvidenceDescriptor | null = null;
  await storeOrUpdateFinalVideoAssetWithId(
    finalVideoAssetIdentity(input),
    input.sourceUrl,
    {
      finalResolution: fallbackResolution,
      requestedResolution: input.plan.requestedResolution,
      enhancementFallback: true,
      enhancementError: input.reason,
    },
    (stored) => {
      deliverySourceEvidence = createRelaySourceEvidenceDescriptor({
        taskId: input.taskId,
        channelId: input.channelId,
        generationAttemptId: input.generationAttemptId,
        sourceUrl: stored.url,
        resolution: fallbackResolution || "",
        retainedAssetId: stored.assetId,
      });
      deliveryFinalEvidence = createRelayFinalEvidenceDescriptor({
        taskId: input.taskId,
        channelId: input.channelId,
        generationAttemptId: input.generationAttemptId,
        assetId: stored.assetId,
        resultUrl: stored.url,
        resolution: fallbackResolution || "",
        kind: "fallback_source",
      });
      return {
        deliverySourceEvidence,
        ...(deliveryFinalEvidence ? { deliveryFinalEvidence } : {}),
      };
    },
    {
      leaseOwner: input.leaseOwner,
      providerTaskId: input.generationAttemptId,
    },
  );
  return {
    status: "succeeded",
    resultPayload: {
      provider: input.payload,
      public: {
        video_url: input.sourceUrl,
        resolution: fallbackResolution,
      },
      internal: {
        ...buildVideoInternalPlan(
          input.plan,
          parseJsonObject(input.persistedResultPayload.internal),
        ),
        ...(deliverySourceEvidence ? { deliverySourceEvidence } : {}),
        ...(deliveryFinalEvidence ? { deliveryFinalEvidence } : {}),
        finalization: "enhancement_failed_fallback",
        deliveredResolution: fallbackResolution,
        enhancementError: input.reason,
      },
      enhancement: input.enhancementPayload
        ? {
            status: "failed",
            payload: input.enhancementPayload,
          }
        : undefined,
    },
    errorMessage: null,
  };
}

function videoEnhancement(resultPayload: Record<string, unknown>): Record<string, unknown> {
  return parseJsonObject(resultPayload.enhancement);
}

function videoEnhancementSubmission(resultPayload: Record<string, unknown>): Record<string, unknown> {
  return parseJsonObject(videoEnhancement(resultPayload).submission);
}

function hasVideoEnhancementDispatchEvidence(resultPayload: Record<string, unknown>): boolean {
  const state = String(videoEnhancementSubmission(resultPayload).state || "");
  return [
    "dispatch_started",
    "accepted",
    "synchronous_succeeded",
    "pending_reconcile",
  ].includes(state);
}

async function persistVideoEnhancementResult(
  task: RelayTask,
  resultPayload: Record<string, unknown>,
): Promise<RelayTask> {
  const now = Date.now();
  if (
    !task.leaseOwner
    || !task.providerTaskId
    || !Number.isSafeInteger(task.leaseExpiresAt)
    || Number(task.leaseExpiresAt) <= now
    || !["running", "enhancing"].includes(task.status)
  ) {
    throw new RelayFinalizationFenceError();
  }
  const affected = await db("o_relay_task")
    .where({
      id: task.id,
      status: task.status,
      leaseOwner: task.leaseOwner,
      leaseExpiresAt: task.leaseExpiresAt,
      providerTaskId: task.providerTaskId,
    })
    .where("leaseExpiresAt", ">", now)
    .update({
      resultPayload: stringifyJson(resultPayload),
      updateTime: now,
      heartbeatAt: now,
    });
  if (Number(affected || 0) !== 1) throw new RelayFinalizationFenceError();
  const persisted = await getRelayTask(task.id);
  if (!persisted) throw new RelayFinalizationFenceError();
  return persisted;
}

async function hasCompleteVideoEnhancementReservation(
  task: RelayTask,
  client: Knex | Knex.Transaction = db,
  lockedLedger?: any,
  lockedUsage?: any,
): Promise<boolean> {
  const ledger = lockedLedger ?? (task.workspaceId ? await client("o_billing_ledger")
    .where({ workspaceId: task.workspaceId, type: "freeze", relatedTaskId: task.id })
    .orderBy("createdAt", "desc").first() : null);
  if (!ledger || !String(ledger.requestId || "").trim()
    || String(ledger.requestId) !== String(task.requestId || "")) return false;
  const usage = lockedUsage ?? (ledger.relatedUsageId ? await client("o_usage_record")
    .where({ id: ledger.relatedUsageId }).first() : null);
  try {
    const reservation = await readVideoBillingReservation(task, false, client);
    const billing = parseJsonObject(task.providerPayload.billing);
    const storedAuthorization = parseJsonObject(task.providerPayload.identity).billingAuthorization;
    const ledgerAuthorization = parseJsonObject(ledger.metadata).billingAuthorization;
    if (storedAuthorization != null || ledgerAuthorization != null) {
      if (!storedAuthorization || typeof storedAuthorization !== "object" || Array.isArray(storedAuthorization)) return false;
      const authorization = storedAuthorization as RelayVideoBillingAuthorization;
      assertTrustedVideoBillingAuthorizationInput(authorization, {
        endpointType: task.endpointType, workspaceId: task.workspaceId,
        projectId: task.projectId, provider: task.provider, model: task.model,
        requestPayload: task.requestPayload,
        requestId: String(task.requestId || "").split(":scope:")[0],
      });
      if (!authorizedVideoReservationBindingMatches(task, authorization, ledger, usage)) return false;
    }
    return Boolean(reservation && usage
      && reservation.id === String(ledger.id)
      && reservation.remainingMicros === reservation.amountMicros
      && reservation.remainingMicros > 0 && reservation.usageStatus === "reserved"
      && String(usage.workspaceId || "") === String(task.workspaceId || "")
      && String(usage.taskId || "") === task.id
      && String(usage.model || "") === String(task.model || "")
      && (!billing.reservationId || billing.reservationId === reservation.id)
      && (!billing.usageRecordId || billing.usageRecordId === reservation.usageRecordId));
  } catch (error) {
    if (!(error instanceof BillingError)) throw error;
    return false;
  }
}

/** Recheck the original reservation atomically with the second provider dispatch marker. */
async function authorizeVideoEnhancementDispatch(
  task: RelayTask,
  resultPayload: Record<string, unknown>,
  sourceUrl: string,
  sourceResolution: string | null,
): Promise<{ authorized: boolean; task: RelayTask }> {
  return db.transaction(async (trx) => {
    const now = Date.now();
    const row = await trx("o_relay_task").where({
      id: task.id, status: task.status, leaseOwner: task.leaseOwner,
      leaseExpiresAt: task.leaseExpiresAt, providerTaskId: task.providerTaskId,
    }).where("leaseExpiresAt", ">", now).forUpdate().first();
    if (!row) throw new RelayFinalizationFenceError();
    const current = parseRelayTask(row);
    if (hasVideoEnhancementDispatchEvidence(current.resultPayload)
      || pickFirst(current.resultPayload, ["enhancement.taskId", "enhancement.task_id"])) {
      throw new RelayFinalizationFenceError();
    }

    // Keep the task -> ledger -> usage lock order used by billing mutation fences.
    const ledger = current.workspaceId ? await trx("o_billing_ledger")
      .where({ workspaceId: current.workspaceId, type: "freeze", relatedTaskId: current.id })
      .orderBy("createdAt", "desc").forUpdate().first() : null;
    const usage = ledger?.relatedUsageId ? await trx("o_usage_record")
      .where({ id: ledger.relatedUsageId }).forUpdate().first() : null;
    const code = ledger ? "video_enhancement_reservation_invalid" : "video_enhancement_reservation_missing";
    const funded = await hasCompleteVideoEnhancementReservation(current, trx, ledger, usage);
    const persistedResult = funded ? resultPayload : {
      ...current.resultPayload,
      provider: resultPayload.provider,
      internal: {
        ...parseJsonObject(resultPayload.internal),
        ...(parseJsonObject(current.resultPayload.internal).deliverySourceEvidence
          ? { deliverySourceEvidence: parseJsonObject(current.resultPayload.internal).deliverySourceEvidence }
          : {}),
      },
      public: {
        video_url: sourceUrl,
        resolution: sourceResolution,
        ...parseJsonObject(current.resultPayload.public),
      },
      enhancement: {
        ...videoEnhancement(current.resultPayload),
        status: "blocked",
        submission: { state: "blocked_before_dispatch", code, checkedAt: now, retryAllowed: false },
      },
    };
    const affected = await trx("o_relay_task").where({
      id: current.id, status: current.status, leaseOwner: current.leaseOwner,
      leaseExpiresAt: current.leaseExpiresAt, providerTaskId: current.providerTaskId,
    }).where("leaseExpiresAt", ">", Date.now()).update({
      resultPayload: stringifyJson(persistedResult), updateTime: now,
      ...(funded ? { heartbeatAt: now } : releaseLeasePatch()),
    });
    if (Number(affected || 0) !== 1) throw new RelayFinalizationFenceError();
    const persisted = await trx("o_relay_task").where({ id: current.id }).first();
    if (!persisted) throw new RelayFinalizationFenceError();
    return { authorized: funded, task: parseRelayTask(persisted) };
  });
}

async function markVideoEnhancementSubmissionUncertain(input: {
  task: RelayTask;
  reason: string;
  message: string;
  resultPayload?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
}): Promise<RelayTask> {
  const uncertainAt = Date.now();
  const candidateResultPayload = input.resultPayload || input.task.resultPayload;
  const enhancement = videoEnhancement(candidateResultPayload);
  const submission = videoEnhancementSubmission(candidateResultPayload);
  const pendingResultPayload = {
    ...candidateResultPayload,
    enhancement: {
      ...enhancement,
      status: "pending_reconcile",
      submission: {
        ...submission,
        state: "pending_reconcile",
        reconcileReason: input.reason,
        uncertainAt,
        retryAllowed: false,
      },
    },
  };
  const persistedTask = await persistVideoEnhancementResult(input.task, pendingResultPayload);
  const billingChannelRow = persistedTask.channelId
    ? await db("o_provider_channel").where({ id: persistedTask.channelId }).first()
    : null;
  if (!billingChannelRow) {
    return await keepVideoBillingRetryable(
      persistedTask,
      "enhancement_pending_reconcile_channel_missing",
      new Error("video billing channel missing"),
    );
  }
  const billingChannel = parseRelayChannel(billingChannelRow);
  if (
    billingChannel.provider !== persistedTask.provider
    || billingChannel.endpointType !== "video_generation"
  ) {
    return await keepVideoBillingRetryable(
      persistedTask,
      "enhancement_pending_reconcile_channel_mismatch",
      new Error("video billing channel mismatch"),
    );
  }
  return await markVideoSubmissionUncertain({
    task: persistedTask,
    channel: billingChannel,
    reason: input.reason,
    message: input.message,
    evidence: {
      phase: "enhancement_submission",
      generationProviderTaskIdPresent: Boolean(persistedTask.providerTaskId),
      ...(input.evidence || {}),
    },
  });
}

async function haltVideoEnhancementSubmission(input: {
  task: RelayTask;
  reason: string;
  message: string;
  resultPayload?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
}): Promise<never> {
  try {
    await markVideoEnhancementSubmissionUncertain(input);
  } finally {
    throw new RelayEnhancementSubmissionHaltedError();
  }
}

async function finalizeSynchronousVideoEnhancement(input: {
  taskId: string;
  channelId: string;
  generationAttemptId: string;
  leaseOwner: string;
  workspaceId: string | null;
  requestId: string | null;
  prompt: string | null;
  model: string | null;
  sourceUrl: string;
  plan: VideoResolutionPlan;
  payload: Record<string, unknown>;
  enhancementPayload: Record<string, unknown>;
  persistedResultPayload: Record<string, unknown>;
}): Promise<{ status: RelayTaskStatus; resultPayload: Record<string, unknown>; errorMessage: string | null }> {
  const finalUrl = extractVideoUrl(input.enhancementPayload);
  if (!finalUrl) {
    throw new RelayEnhancementSubmissionHaltedError(
      "Persisted synchronous enhancement result has no final URL",
    );
  }
  let deliveryFinalEvidence: RelayFinalEvidenceDescriptor | null = null;
  await storeOrUpdateFinalVideoAssetWithId(
    finalVideoAssetIdentity(input),
    finalUrl,
    {
      finalResolution: input.plan.finalResolution,
      requestedResolution: input.plan.requestedResolution,
    },
    (stored) => {
      deliveryFinalEvidence = createRelayFinalEvidenceDescriptor({
        taskId: input.taskId,
        channelId: input.channelId,
        generationAttemptId: input.generationAttemptId,
        winningAttemptSeed: extractProviderTaskId(input.enhancementPayload) ?? stored.url,
        assetId: stored.assetId,
        resultUrl: stored.url,
        resolution: input.plan.finalResolution || "",
        kind: "enhancement_output",
      });
      return deliveryFinalEvidence ? { deliveryFinalEvidence } : {};
    },
    {
      leaseOwner: input.leaseOwner,
      providerTaskId: input.generationAttemptId,
    },
  );
  const persistedInternal = parseJsonObject(input.persistedResultPayload.internal);
  const persistedEnhancement = videoEnhancement(input.persistedResultPayload);
  return {
    status: "succeeded",
    resultPayload: {
      ...input.persistedResultPayload,
      provider: input.payload,
      internal: {
        ...buildVideoInternalPlan(input.plan, persistedInternal),
        ...(deliveryFinalEvidence ? { deliveryFinalEvidence } : {}),
      },
      public: {
        video_url: finalUrl,
        resolution: input.plan.finalResolution,
      },
      enhancement: {
        ...persistedEnhancement,
        status: "succeeded",
        payload: input.enhancementPayload,
      },
    },
    errorMessage: null,
  };
}

async function submitVideoEnhancement(input: {
  taskId: string;
  channelId: string;
  generationAttemptId: string;
  leaseOwner: string;
  workspaceId: string | null;
  requestId: string | null;
  prompt: string | null;
  model: string | null;
  sourceUrl: string;
  plan: VideoResolutionPlan;
  payload: Record<string, unknown>;
}): Promise<{ status: RelayTaskStatus; resultPayload: Record<string, unknown>; errorMessage: string | null }> {
  const config = await resolveVideoEnhanceConfigForPlan(input.plan);
  const deliverySourceEvidence = createRelaySourceEvidenceDescriptor({
    taskId: input.taskId,
    channelId: input.channelId,
    generationAttemptId: input.generationAttemptId,
    sourceUrl: input.sourceUrl,
    resolution: input.plan.generationResolution || "",
  });
  let task = await getRelayTask(input.taskId);
  if (
    !task
    || task.providerTaskId !== input.generationAttemptId
    || task.leaseOwner !== input.leaseOwner
  ) {
    throw new RelayFinalizationFenceError();
  }
  if (storedPrivateValidationBudget(task)) {
    return await haltVideoEnhancementSubmission({
      task,
      reason: "private_validation_budget_secondary_provider_task_blocked",
      message: "私有验证预算禁止创建第二个上游高清处理任务，系统正在自动核实。",
      evidence: {
        providerRequestStarted: false,
        generationProviderTaskIdPresent: true,
      },
    });
  }
  const internal = {
    ...buildVideoInternalPlan(input.plan, task.resultPayload.internal),
    deliverySourceEvidence,
  };
  const existingEnhancement = videoEnhancement(task.resultPayload);
  const existingSubmission = videoEnhancementSubmission(task.resultPayload);
  const existingEnhanceTaskId = pickFirst(task.resultPayload, [
    "enhancement.taskId",
    "enhancement.task_id",
  ]);
  if (existingEnhanceTaskId) {
    return {
      status: "enhancing",
      resultPayload: task.resultPayload,
      errorMessage: null,
    };
  }
  if (String(existingSubmission.state || "") === "synchronous_succeeded") {
    const enhancementPayload = parseJsonObject(existingEnhancement.payload);
    if (!extractVideoUrl(enhancementPayload)) {
      return await haltVideoEnhancementSubmission({
        task,
        reason: "enhancement_synchronous_result_invalid",
        message: "已持久化的同步高清结果缺少有效视频地址，系统正在自动核实。",
        evidence: { recovery: true },
      });
    }
    return await finalizeSynchronousVideoEnhancement({
      ...input,
      enhancementPayload,
      persistedResultPayload: task.resultPayload,
    });
  }
  if (hasVideoEnhancementDispatchEvidence(task.resultPayload)) {
    return await haltVideoEnhancementSubmission({
      task,
      reason: String(existingSubmission.reconcileReason || "enhancement_recovery_without_provider_task_id"),
      message: "高清处理提交结果不确定，系统正在自动核实提交结果，请查询任务状态。",
      evidence: { recovery: true },
    });
  }
  if (!config) {
    return await fallbackToGeneratedVideo({
      ...input,
      persistedResultPayload: task.resultPayload,
      reason: input.plan.enhanceChannelId
        ? "配方绑定的超分通道不可用或未配置密钥"
        : "目标清晰度处理通道未配置",
    });
  }

  const providerRequestPayload = buildVideoEnhanceRequestPayload({
    taskId: input.taskId,
    sourceUrl: input.sourceUrl,
    plan: input.plan,
  });
  const dispatchStartedAt = Date.now();
  const dispatchResultPayload = {
    ...task.resultPayload,
    provider: input.payload,
    internal,
    enhancement: {
      ...existingEnhancement,
      status: "submitting",
      startedAt: dispatchStartedAt,
      submission: {
        state: "dispatch_started",
        dispatchStartedAt,
        retryAllowed: false,
        requestHash: crypto
          .createHash("sha256")
          .update(stableStringifyJson(providerRequestPayload))
          .digest("hex"),
      },
    },
  };
  const dispatch = await authorizeVideoEnhancementDispatch(
    task, dispatchResultPayload, input.sourceUrl, input.plan.generationResolution,
  );
  if (!dispatch.authorized) throw new RelayEnhancementSubmissionHaltedError();
  task = dispatch.task;

  let response: Response;
  let payload: Record<string, unknown>;
  try {
    const submission = await fetchProviderSubmissionWithFreshConnection({
      url: config.submitEndpoint,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(providerRequestPayload),
      },
      timeoutMs: Number(process.env.FANJIN_VIDEO_ENHANCE_TIMEOUT_MS || 600000),
      consume: readJsonResponse,
    });
    response = submission.response;
    payload = submission.value;
  } catch (error: any) {
    const transportErrorCode = providerSubmissionTransportErrorCode(error);
    return await haltVideoEnhancementSubmission({
      task,
      reason: /timed out/i.test(String(error?.message || ""))
        ? "enhancement_submit_timeout"
        : "enhancement_submit_network_error",
      message: redactRelayText(error?.message || "高清处理提交失败"),
      evidence: {
        errorClass: String(error?.name || "Error"),
        ...(transportErrorCode ? { errorCode: transportErrorCode } : {}),
        connectionMode: "fresh_non_pipelined_single_post",
      },
    });
  }
  if (!response.ok) {
    return await haltVideoEnhancementSubmission({
      task,
      reason: `enhancement_submit_http_${response.status}`,
      message: getResponseErrorMessage(payload, response.statusText || `HTTP ${response.status}`),
      resultPayload: {
        ...task.resultPayload,
        enhancement: {
          ...videoEnhancement(task.resultPayload),
          payload,
        },
      },
      evidence: { httpStatus: response.status },
    });
  }

  const finalUrl = extractVideoUrl(payload);
  if (finalUrl) {
    const responsePersistedAt = Date.now();
    const synchronousResultPayload = {
      ...task.resultPayload,
      provider: input.payload,
      internal,
      enhancement: {
        ...videoEnhancement(task.resultPayload),
        status: "synchronous_succeeded",
        payload,
        submission: {
          ...videoEnhancementSubmission(task.resultPayload),
          state: "synchronous_succeeded",
          responsePersistedAt,
          httpStatus: response.status,
          retryAllowed: false,
        },
      },
    };
    try {
      task = await persistVideoEnhancementResult(task, synchronousResultPayload);
    } catch {
      return await haltVideoEnhancementSubmission({
        task,
        reason: "enhancement_synchronous_result_persistence_failed",
        message: "高清处理同步结果无法安全持久化，系统正在自动核实。",
        resultPayload: synchronousResultPayload,
        evidence: { httpStatus: response.status, synchronousResultPresent: true },
      });
    }
    return await finalizeSynchronousVideoEnhancement({
      ...input,
      enhancementPayload: payload,
      persistedResultPayload: task.resultPayload,
    });
  }

  const enhanceTaskId = extractProviderTaskId(payload);
  if (enhanceTaskId) {
    const acceptedAt = Date.now();
    const acceptedResultPayload = {
      ...task.resultPayload,
      provider: input.payload,
      internal,
      enhancement: {
        ...videoEnhancement(task.resultPayload),
        taskId: enhanceTaskId,
        status: "enhancing",
        startedAt: dispatchStartedAt,
        payload,
        submission: {
          ...videoEnhancementSubmission(task.resultPayload),
          state: "accepted",
          acceptedAt,
          httpStatus: response.status,
          retryAllowed: false,
        },
      },
    };
    try {
      task = await persistVideoEnhancementResult(task, acceptedResultPayload);
    } catch {
      return await haltVideoEnhancementSubmission({
        task,
        reason: "enhancement_provider_task_id_persistence_failed",
        message: "高清处理任务号无法安全持久化，系统正在自动核实。",
        resultPayload: acceptedResultPayload,
        evidence: { httpStatus: response.status, providerTaskIdPresent: true },
      });
    }
    return {
      status: "enhancing",
      resultPayload: task.resultPayload,
      errorMessage: null,
    };
  }

  return await haltVideoEnhancementSubmission({
    task,
    reason: "enhancement_submit_invalid_2xx",
    message: "高清处理返回 2xx，但缺少合法任务号或同步成品，系统正在自动核实。",
    resultPayload: {
      ...task.resultPayload,
      enhancement: {
        ...videoEnhancement(task.resultPayload),
        payload,
      },
    },
    evidence: { httpStatus: response.status },
  });
}

async function pollVideoEnhancement(task: RelayTask): Promise<{ status: RelayTaskStatus; resultPayload: Record<string, unknown>; errorMessage: string | null }> {
  const plan = restoreVideoResolutionPlanFromInternal(task.resultPayload, task.requestPayload);
  const enhanceTaskId = pickFirst(task.resultPayload, ["enhancement.taskId", "enhancement.task_id"]);
  const config = plan.enhanceChannelId && enhanceTaskId && !isFormalCandidateCredentialRuntimeDeclared()
    ? mediaKitExistingTaskQueryConfig(await findMediaService(db as any, plan.enhanceChannelId, "mediakit"))
    : await resolveVideoEnhanceConfigForPlan(plan);
  if (!config || !config.statusEndpoint || !enhanceTaskId) {
    return {
      status: "enhancing",
      resultPayload: task.resultPayload,
      errorMessage: null,
    };
  }

  const encodedTaskId = encodeURIComponent(String(enhanceTaskId));
  const url = config.statusEndpoint.replace("{taskId}", encodedTaskId).replace("{task_id}", encodedTaskId);
  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
    },
    Number(process.env.FANJIN_VIDEO_ENHANCE_TIMEOUT_MS || 600000),
  );
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    return {
      status: "enhancing",
      resultPayload: {
        ...task.resultPayload,
        enhancement: {
          ...((task.resultPayload.enhancement as Record<string, unknown>) || {}),
          lastPoll: {
            status: response.status,
            message: getResponseErrorMessage(payload, response.statusText),
            retryable: true,
            at: Date.now(),
          },
        },
      },
      errorMessage: null,
    };
  }
  const providerStatus = normalizeProviderStatus(pickFirst(payload, ["status", "data.status", "result.status"]));
  const status: RelayTaskStatus = providerStatus === "running" || providerStatus === "queued" ? "enhancing" : providerStatus;
  const finalUrl = extractVideoUrl(payload);
  const previousInternal = parseJsonObject(task.resultPayload.internal);
  const nextInternal = buildVideoInternalPlan(plan, previousInternal);
  if (!readRelaySourceEvidenceDescriptor(nextInternal.deliverySourceEvidence)) {
    const generationSourceUrl = extractVideoUrl(
      parseJsonObject(task.resultPayload.provider),
    );
    if (
      generationSourceUrl
      && task.channelId
      && task.providerTaskId
      && plan.generationResolution
    ) {
      // Upgrade bridge for tasks that entered `enhancing` before v0.0.7 began
      // persisting source descriptors.  The proof is reconstructed only from
      // the server-owned provider result and immutable task lineage.
      nextInternal.deliverySourceEvidence = createRelaySourceEvidenceDescriptor({
        taskId: task.id,
        channelId: task.channelId,
        generationAttemptId: task.providerTaskId,
        sourceUrl: generationSourceUrl,
        resolution: plan.generationResolution,
      });
    }
  }
  const nextPayload = {
    ...task.resultPayload,
    internal: nextInternal,
    enhancement: {
      ...((task.resultPayload.enhancement as Record<string, unknown>) || {}),
      payload,
      status,
    },
  };

  if (status === "succeeded" && finalUrl) {
    let deliveryFinalEvidence: RelayFinalEvidenceDescriptor | null = null;
    await storeOrUpdateFinalVideoAssetWithId(
      finalVideoAssetIdentity({
        taskId: task.id,
        workspaceId: task.workspaceId,
        requestId: task.requestId,
        prompt: videoPromptFromRequestPayload(task.requestPayload),
        model: task.model,
      }),
      finalUrl,
      {
        finalResolution: plan.finalResolution,
        requestedResolution: plan.requestedResolution,
      },
      (stored) => {
        deliveryFinalEvidence = createRelayFinalEvidenceDescriptor({
          taskId: task.id,
          channelId: task.channelId || "",
          generationAttemptId: task.providerTaskId || task.id,
          winningAttemptSeed: String(enhanceTaskId),
          assetId: stored.assetId,
          resultUrl: stored.url,
          resolution: plan.finalResolution || "",
          kind: "enhancement_output",
        });
        return deliveryFinalEvidence ? { deliveryFinalEvidence } : {};
      },
      {
        leaseOwner: String(task.leaseOwner || ""),
        providerTaskId: String(task.providerTaskId || task.id),
      },
    );
    return {
      status: "succeeded",
      resultPayload: {
        ...nextPayload,
        internal: {
          ...((nextPayload.internal as Record<string, unknown>) || {}),
          ...(deliveryFinalEvidence ? { deliveryFinalEvidence } : {}),
        },
        public: {
          video_url: finalUrl,
          resolution: plan.finalResolution,
        },
      },
      errorMessage: null,
    };
  }

  if (status === "failed") {
    const originalUrl = extractVideoUrl(task.resultPayload.provider as Record<string, unknown>);
    if (originalUrl) {
      return await fallbackToGeneratedVideo({
        taskId: task.id,
        channelId: task.channelId || "",
        generationAttemptId: task.providerTaskId || task.id,
        leaseOwner: String(task.leaseOwner || ""),
        workspaceId: task.workspaceId,
        requestId: task.requestId,
        prompt: videoPromptFromRequestPayload(task.requestPayload),
        model: task.model,
        sourceUrl: originalUrl,
        plan,
        payload: (task.resultPayload.provider as Record<string, unknown>) || {},
        persistedResultPayload: task.resultPayload,
        reason: getResponseErrorMessage(payload, response.statusText),
        enhancementPayload: payload,
      });
    }
    return {
      status: "failed",
      resultPayload: nextPayload,
      errorMessage: getResponseErrorMessage(payload, response.statusText),
    };
  }

  return {
    status: "enhancing",
    resultPayload: nextPayload,
    errorMessage: null,
  };
}

async function finalizeSucceededGeneration(input: {
  taskId: string;
  channelId: string;
  generationAttemptId: string;
  leaseOwner: string;
  workspaceId: string | null;
  requestId: string | null;
  prompt: string | null;
  model: string | null;
  payload: Record<string, unknown>;
  plan: VideoResolutionPlan;
  persistedResultPayload: Record<string, unknown>;
}): Promise<{ status: RelayTaskStatus; resultPayload: Record<string, unknown>; errorMessage: string | null }> {
  const videoUrl = extractVideoUrl(input.payload);
  if (!videoUrl) {
    return {
      status: "succeeded",
      resultPayload: {
        ...input.payload,
        internal: buildVideoInternalPlan(
          input.plan,
          input.persistedResultPayload.internal,
        ),
      },
      errorMessage: null,
    };
  }

  if (input.plan.needsEnhancement) {
    return await submitVideoEnhancement({
      taskId: input.taskId,
      channelId: input.channelId,
      generationAttemptId: input.generationAttemptId,
      leaseOwner: input.leaseOwner,
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      prompt: input.prompt,
      model: input.model,
      sourceUrl: videoUrl,
      plan: input.plan,
      payload: input.payload,
    });
  }

  let deliveryFinalEvidence: RelayFinalEvidenceDescriptor | null = null;
  await storeOrUpdateFinalVideoAssetWithId(
    finalVideoAssetIdentity(input),
    videoUrl,
    {
      finalResolution: input.plan.finalResolution,
      requestedResolution: input.plan.requestedResolution,
    },
    (stored) => {
      deliveryFinalEvidence = createRelayFinalEvidenceDescriptor({
        taskId: input.taskId,
        channelId: input.channelId,
        generationAttemptId: input.generationAttemptId,
        assetId: stored.assetId,
        resultUrl: stored.url,
        resolution: input.plan.finalResolution || "",
        kind: "generation_output",
      });
      return deliveryFinalEvidence ? { deliveryFinalEvidence } : {};
    },
    {
      leaseOwner: input.leaseOwner,
      providerTaskId: input.generationAttemptId,
    },
  );
  return {
    status: "succeeded",
    resultPayload: {
      ...input.payload,
      internal: {
        ...buildVideoInternalPlan(
          input.plan,
          input.persistedResultPayload.internal,
        ),
        ...(deliveryFinalEvidence ? { deliveryFinalEvidence } : {}),
      },
      public: {
        video_url: videoUrl,
        resolution: input.plan.finalResolution,
      },
    },
    errorMessage: null,
  };
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {
      raw: text,
    };
  }
}

export function parseRelayTask(row: any): RelayTask {
  return {
    id: row.id,
    apiKeyId: row.apiKeyId ?? null,
    workspaceId: row.workspaceId ?? null,
    projectId: row.projectId == null ? null : Number(row.projectId),
    requestId: row.requestId ?? null,
    endpointType: row.endpointType,
    provider: row.provider ?? null,
    channelId: row.channelId ?? null,
    model: row.model ?? null,
    status: row.status,
    requestPayload: parseJsonObject(row.requestPayload),
    providerPayload: parseJsonObject(row.providerPayload),
    providerTaskId: row.providerTaskId ?? null,
    resultPayload: parseJsonObject(row.resultPayload),
    errorMessage: row.errorMessage ?? null,
    quotaReserved: Number(row.quotaReserved || 0),
    apiQuotaReserved: Number(row.apiQuotaReserved || 0),
    costMicros: Number(row.costMicros || 0),
    leaseOwner: row.leaseOwner ?? null,
    leaseExpiresAt: row.leaseExpiresAt ? Number(row.leaseExpiresAt) : null,
    attemptCount: Number(row.attemptCount || 0),
    heartbeatAt: row.heartbeatAt ? Number(row.heartbeatAt) : null,
    createTime: Number(row.createTime || 0),
    updateTime: Number(row.updateTime || 0),
    submittedAt: row.submittedAt ? Number(row.submittedAt) : null,
    completedAt: row.completedAt ? Number(row.completedAt) : null,
  };
}

function applyScopeFilter(query: Knex.QueryBuilder, workspaceId?: string | null): Knex.QueryBuilder {
  return query.where((builder) => {
    builder.where((platformBuilder) => platformBuilder.where("scope", "platform").whereNull("workspaceId"));
    if (workspaceId) builder.orWhere({ scope: "workspace", workspaceId });
  });
}

function relayRouteBindingMatchesChannel(
  route: Record<string, any>,
  channel: Record<string, any>,
  input: Pick<CreateRelayTaskInput, "endpointType" | "provider" | "workspaceId">,
): boolean {
  if (route.disabled === true || Number(route.disabled) === 1) return false;
  if (channel.disabled === true || Number(channel.disabled) === 1) return false;
  if (String(route.channelId || "").trim() !== String(channel.id || "").trim()) return false;
  if (String(route.endpointType || "").trim() !== String(input.endpointType || "").trim()) return false;
  if (String(channel.endpointType || "").trim() !== String(input.endpointType || "").trim()) return false;

  const expectedProvider = String(route.provider || input.provider || "").trim();
  const channelProvider = String(channel.provider || "").trim();
  if (!channelProvider || (expectedProvider && channelProvider !== expectedProvider)) return false;

  const routeScope = String(route.scope || "").trim();
  const channelScope = String(channel.scope || "").trim();
  const routeWorkspaceId = String(route.workspaceId || "").trim();
  const channelWorkspaceId = String(channel.workspaceId || "").trim();
  if (routeScope === "platform") {
    return route.workspaceId == null && channelScope === "platform" && channel.workspaceId == null;
  }
  if (routeScope !== "workspace" || !routeWorkspaceId || routeWorkspaceId !== String(input.workspaceId || "").trim()) {
    return false;
  }
  return channelScope === "platform"
    ? !channelWorkspaceId
    : channelScope === "workspace" && routeWorkspaceId === channelWorkspaceId;
}

function parseRelayChannel(row: any): RelayChannel {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    endpointType: row.endpointType,
    baseUrl: row.baseUrl ?? null,
    credentialRef: row.credentialRef ?? null,
    credentialCiphertext: row.credentialCiphertext ?? null,
    config: parseJsonObject(row.configJson),
    timeoutMs: Number(row.timeoutMs || 600000),
  };
}

async function channelHasCapacity(row: any): Promise<boolean> {
  const limit = Number(row.concurrencyLimit || 0);
  if (!Number.isFinite(limit) || limit <= 0) return true;
  const now = Date.now();
  await db("o_provider_channel_slot").where({ channelId: row.id }).where("leaseExpiresAt", "<", now).del();
  const [taskCountRow, slotCountRow] = await Promise.all([
    db("o_relay_task").where({ channelId: row.id }).whereIn("status", ["queued", "running", "enhancing"]).count({ total: "*" }).first(),
    db("o_provider_channel_slot").where({ channelId: row.id }).where("leaseExpiresAt", ">", now).count({ total: "*" }).first(),
  ]);
  const activeTasks = Number((taskCountRow as any)?.total || 0);
  const activeSlots = Number((slotCountRow as any)?.total || 0);
  return activeTasks + activeSlots < limit;
}

export async function reserveQuota(input: CreateRelayTaskInput): Promise<{ reserved: boolean; quotaReserved: number }> {
  const taskId = (input as any).taskId;
  if (!taskId) return { reserved: false, quotaReserved: 0 };
  const result = await reserveRelayBilling({
    ...input,
    taskId,
    channelId: (input as any).channelId ?? null,
  });
  return {
    reserved: result.reserved,
    quotaReserved: result.quotaReserved,
  };
}

interface VideoPricingPlan {
  rule: PricingRule;
  unit: "task" | "video" | "token";
  pricingRuleBaseUnitPriceMicros: number;
  unitPriceMicros: number;
  multiplier: number;
  minimumMicros: number;
  videoInputPricingTier: VideoInputPricingTier;
  videoInputPricingConfigured: boolean;
  reservationUnits: number;
  costMicros: number;
  valueVideoPricingSnapshot: Record<string, unknown> | null;
  priceSnapshot: Record<string, unknown>;
}

interface VideoBillingReservation {
  id: string;
  workspaceId: string;
  requestId: string;
  amountMicros: number;
  remainingMicros: number;
  usageRecordId: string;
  units: number;
  usageUnits: number;
  unit: string;
  usageStatus: string;
  provider: string;
  channelId: string;
  billingKey: string;
  metadata: Record<string, unknown>;
}

function relayVideoBillingMutationFence(task: RelayTask): RelayVideoBillingMutationFence {
  if (
    !task.workspaceId
    || !task.leaseOwner
    || !Number.isSafeInteger(task.leaseExpiresAt)
    || Number(task.leaseExpiresAt) <= Date.now()
  ) {
    throw new BillingError("Relay 视频任务缺少有效计费 lease/fence", 409);
  }
  return {
    kind: "relay_video_operation/v1",
    taskId: task.id,
    workspaceId: task.workspaceId,
    leaseOwner: task.leaseOwner,
    leaseExpiresAt: Number(task.leaseExpiresAt),
  };
}

function relayRequestSubject(input: Pick<CreateRelayTaskInput, "apiKeyId" | "principalId" | "workspaceId">): string | null {
  const apiKeyId = String(input.apiKeyId || "").trim();
  if (apiKeyId) return `api-key:${apiKeyId}`;
  const principalId = String(input.principalId || "").trim();
  if (principalId) return `principal:${principalId}`;
  const workspaceId = String(input.workspaceId || "").trim();
  if (workspaceId) return `workspace:${workspaceId}`;
  return null;
}

function scopeRelayRequestId(input: CreateRelayTaskInput): string | null {
  const raw = String(input.requestId || "").trim();
  if (!raw) return null;
  if (raw.length > 512) {
    const error: any = new Error("requestId 长度不能超过 512 个字符");
    error.status = 400;
    error.code = "invalid_request_id";
    throw error;
  }
  const subject = relayRequestSubject(input);
  if (!subject) {
    const error: any = new Error("requestId 必须绑定 API Key 或工作区主体");
    error.status = 400;
    error.code = "unscoped_request_id";
    throw error;
  }
  const scopeDigest = crypto.createHash("sha256").update(`${input.endpointType}:${subject}`).digest("hex");
  // Keep the caller's operational prefix (workbench:/quick-create:) so task
  // center filters remain useful, while the suffix makes the database key
  // principal-scoped instead of globally user-controlled.
  return `${raw}:scope:${scopeDigest}`;
}

function assertIdempotentRelayTaskScope(existingTask: any, input: CreateRelayTaskInput): void {
  const sameApiKey = String(existingTask.apiKeyId || "") === String(input.apiKeyId || "");
  const sameWorkspace = String(existingTask.workspaceId || "") === String(input.workspaceId || "");
  const sameProject =
    (existingTask.projectId == null ? null : Number(existingTask.projectId))
    === (input.projectId == null ? null : Number(input.projectId));
  const sameEndpoint = String(existingTask.endpointType || "") === String(input.endpointType || "");
  const storedIdentity = parseJsonObject(existingTask.providerPayload).identity;
  const storedSubject = storedIdentity && typeof storedIdentity === "object" && !Array.isArray(storedIdentity)
    ? String((storedIdentity as Record<string, unknown>).subject || "")
    : "";
  const expectedSubject = relayRequestSubject(input) || "";
  if (
    !sameApiKey
    || !sameWorkspace
    || !sameProject
    || !sameEndpoint
    || !storedSubject
    || storedSubject !== expectedSubject
  ) {
    const err: any = new Error("Idempotency key scope conflict");
    err.status = 409;
    err.code = "idempotency_scope_conflict";
    throw err;
  }
}

function assertIdempotentRelayTask(existingTask: any, input: CreateRelayTaskInput): RelayTask {
  assertIdempotentRelayTaskScope(existingTask, input);
  const existingPayload = parseJsonObject(existingTask.requestPayload);
  if (stableStringifyJson(existingPayload) !== stableStringifyJson(input.requestPayload)) {
    const err: any = new Error("Idempotency key conflict");
    err.status = 409;
    err.code = "idempotency_conflict";
    throw err;
  }
  return parseRelayTask(existingTask);
}

/** Recover only a pre-canonical public text task, without reservation or dispatch. */
export async function recoverPublicLegacyTextRelayTask(
  input: CreateRelayTaskInput,
  options: Pick<CreateRelayTaskOptions, "trustedCanonicalVideoGeneration" | "trustedVideoAssetPolicyEvidence">,
): Promise<RelayTask | null> {
  input = normalizeRelayTaskInput(input);
  const requestId = scopeRelayRequestId(input);
  if (!requestId || input.endpointType !== "video_generation") return null;
  const existing = await db("o_relay_task").where({ requestId }).first();
  if (!existing) return null;
  const internal = parseJsonObject(parseJsonObject(existing.resultPayload).internal);
  if ([
    "canonicalVideoGeneration", "videoAssetPolicyEvidence", "videoProviderAdapter",
    "structuredTimeline", "seedance25CertificationProbe", "portraitPreparation",
    RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_RELAY_EVIDENCE_KEY,
  ].some(key => internal[key] != null)) return null;
  const canonical = options.trustedCanonicalVideoGeneration;
  const { callback_secret_ciphertext: _sealedCallback, ...legacyPayload } = input.requestPayload;
  const content = legacyPayload.content;
  if (
    !canonical
    || canonical.digest !== videoGenerationRequestDigest(canonical.request)
    || canonical.request.operation !== "generate"
    || canonical.request.inputs.length !== 0
    || containsLegacyVideoMediaRequest(legacyPayload)
    || !Array.isArray(content) || !content.length
    || content.some(item => !item || typeof item !== "object" || Array.isArray(item)
      || !["text", "input_text"].includes(String(item.type)) || typeof item.text !== "string")
    || [SEEDANCE_25_MODEL_ID, BYTEPLUS_SEEDANCE_25_MODEL_ID].includes(String(input.model) as typeof SEEDANCE_25_MODEL_ID)
  ) {
    throw canonicalVideoBindingError("legacy_text_replay_invalid", "旧任务恢复仅支持未绑定统一请求的纯文本视频任务");
  }
  await assertRelayTaskProjectAuthority(input);
  const task = assertIdempotentRelayTask(existing, input);
  if (String(existing.model || "") !== String(input.model || "")) {
    throw canonicalVideoBindingError("idempotency_conflict", "Idempotency key conflict");
  }
  // Recheck the current empty-asset policy, but do not attach new checkpoints
  // or defaults to an already accepted task. Exact old payload equality above
  // includes the server-sealed callback secret and every caller control.
  await resolveFreshVideoAssetPolicyRelayBinding({
    canonicalRequest: canonical.request,
    workspaceId: String(input.workspaceId || ""),
    projectId: input.projectId == null ? "" : String(input.projectId),
    evidence: options.trustedVideoAssetPolicyEvidence ?? null,
  });
  return task;
}

function canonicalReadOnlyReplayPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    ...payload,
    ...(Array.isArray(payload.content) ? {
      content: payload.content.map(item => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return item;
        const record = item as Record<string, unknown>;
        const mediaKey = ["image_url", "video_url", "audio_url"].find(key => record.type === key);
        const media = mediaKey ? record[mediaKey] : null;
        if (!mediaKey || !media || typeof media !== "object" || Array.isArray(media)
          || typeof (media as Record<string, unknown>).url !== "string") return item;
        return { ...record, [mediaKey]: { ...media as Record<string, unknown>, url: "server-resolved-asset-url" } };
      }),
    } : {}),
  };
}

/**
 * Recover the same scoped canonical task after a lost response. URL renewal is
 * allowed only for reading this task: all controls, asset IDs, scope, policy,
 * adapter and any existing billing authorization stay bound. This never repairs a missing
 * reservation or dispatches the persisted (possibly expired) URLs.
 */
export async function recoverCanonicalRelayTask(
  input: CreateRelayTaskInput,
  options: CreateRelayTaskOptions,
): Promise<{ task: RelayTask; channel: null } | null> {
  input = normalizeRelayTaskInput(input);
  const requestId = scopeRelayRequestId(input);
  if (!requestId) return null;
  const existing = await db("o_relay_task").where({ requestId }).first();
  if (!existing) return null;
  assertIdempotentRelayTaskScope(existing, input);
  const authorization = options.trustedVideoBillingAuthorization;
  const canonical = validateTrustedCanonicalVideoGeneration(input, options.trustedCanonicalVideoGeneration ?? null);
  if (!canonical || input.endpointType !== "video_generation") {
    throw canonicalVideoBindingError("canonical_replay_required", "任务恢复必须绑定统一视频请求");
  }
  const adapter = validateTrustedVideoProviderAdapter(input, options.trustedVideoProviderAdapter ?? null, canonical);
  if ([SEEDANCE_25_MODEL_ID, BYTEPLUS_SEEDANCE_25_MODEL_ID].includes(String(input.model) as typeof SEEDANCE_25_MODEL_ID) && !adapter) {
    throw canonicalVideoBindingError("seedance25_trusted_adapter_required", "任务恢复需要正式 Adapter 绑定");
  }
  await assertRelayTaskProjectAuthority(input);
  if (String(existing.model || "") !== String(input.model || "")
    || (input.provider && String(existing.provider || "") !== input.provider)) {
    throw canonicalVideoBindingError("idempotency_conflict", "Idempotency key conflict");
  }
  if (authorization) assertTrustedVideoBillingAuthorizationInput(authorization, input);
  else if (parseJsonObject(parseJsonObject(existing.providerPayload).identity).billingAuthorization != null) {
    throw canonicalVideoBindingError("canonical_authorized_replay_required", "审批绑定任务恢复必须提供原计费授权");
  }
  const internal = parseJsonObject(parseJsonObject(existing.resultPayload).internal);
  const stored = parseJsonObject(internal.canonicalVideoGeneration);
  try {
    const storedRequest = parseJsonObject(stored.request);
    // Normalization is not evidence that an older or damaged checkpoint is valid.
    if (storedRequest.version !== VIDEO_GENERATION_REQUEST_VERSION) throw new Error("version");
    const request = canonicalVideoGenerationRequest(storedRequest as unknown as VideoGenerationRequest);
    if (stored.digest !== videoGenerationRequestDigest(request)) throw new Error("digest");
  } catch {
    throw canonicalVideoBindingError("canonical_video_checkpoint_invalid", "既有任务缺少可核验的统一视频请求检查点");
  }
  assertPersistedCanonicalVideoGeneration(existing, canonical);
  assertPersistedStructuredTimeline(existing, validateTrustedStructuredTimeline(
    input, options.trustedStructuredTimeline ?? null, canonical,
  ));
  assertPersistedPrivateValidationBudget(existing, validateTrustedPrivateValidationBudget(
    input, options.trustedPrivateValidationBudget ?? null, false,
  ));
  assertPersistedSeedance25CertificationProbe(existing, null);
  assertPersistedVideoProviderAdapter(existing, adapter);
  const policy = await resolveFreshVideoAssetPolicyRelayBinding({
    canonicalRequest: canonical.request,
    workspaceId: String(input.workspaceId || ""),
    projectId: input.projectId == null ? "" : String(input.projectId),
    evidence: options.trustedVideoAssetPolicyEvidence ?? null,
  });
  assertPersistedVideoAssetPolicyEvidence(existing, policy);
  const persistedPayload = parseJsonObject(existing.requestPayload);
  if (stableStringifyJson(canonicalReadOnlyReplayPayload(persistedPayload))
    !== stableStringifyJson(canonicalReadOnlyReplayPayload(input.requestPayload))) {
    throw canonicalVideoBindingError("idempotency_conflict", "Idempotency key conflict");
  }
  const replayInput = { ...input, requestPayload: persistedPayload };
  validateTrustedCanonicalVideoGeneration(replayInput, canonical);
  // Quick Create's pricing token authorizes new spending. Reading an existing
  // scoped task cannot spend, so token expiry does not prevent recovery.
  const task = authorization
    ? await assertIdempotentAuthorizedRelayTask(existing, replayInput, authorization, { readOnly: true })
    : assertIdempotentRelayTask(existing, replayInput);
  return { task, channel: null };
}

export async function recoverCanonicalAuthorizedRelayTask(
  input: CreateRelayTaskInput,
  options: CreateRelayTaskOptions,
): Promise<{ task: RelayTask; channel: null } | null> {
  if (!options.trustedVideoBillingAuthorization) {
    throw canonicalVideoBindingError("canonical_authorized_replay_required", "任务恢复必须绑定统一视频请求与可信计费授权");
  }
  return recoverCanonicalRelayTask(input, options);
}

async function resolveVideoPricingPlan(input: CreateRelayTaskInput, channel: RelayChannel,
  canonicalRequest?: VideoGenerationRequest): Promise<VideoPricingPlan> {
  input = { ...input, requestPayload: draftPricingPayload(input.requestPayload, canonicalRequest) };
  if (input.endpointType !== "video_generation" || channel.endpointType !== "video_generation") {
    throw new BillingError("视频任务与供应商通道 endpointType 不匹配，已拒绝调用上游", 402);
  }
  if (!input.workspaceId) throw new BillingError("视频生成计费必须绑定 workspaceId", 402);
  const provider = String(channel.provider || "").trim();
  if (!provider) throw new BillingError("视频通道未配置明确 provider，已拒绝调用上游", 402);
  const rule = await resolveProviderSpecificPricingRule({
    endpointType: "video_generation",
    provider,
    model: input.model || null,
    workspaceId: input.workspaceId,
  });
  if (!rule || rule.provider !== provider || rule.endpointType !== "video_generation") {
    throw new BillingError("未配置当前视频供应商的专属定价规则，已拒绝调用上游", 402);
  }
  if (rule.unit !== "task" && rule.unit !== "video" && rule.unit !== "token") {
    throw new BillingError(`视频定价单位必须为 task、video 或 token，当前为 ${rule.unit || "unknown"}`, 402);
  }
  if (rule.unit === "token" && provider !== "volcano") {
    throw new BillingError("视频 token 计费目前仅支持返回权威 usage.completion_tokens 的火山引擎通道", 402);
  }
  if (rule.currency !== "GU") {
    throw new BillingError(`视频定价币种必须为 GU，当前为 ${rule.currency || "unknown"}`, 402);
  }
  if (!Number.isSafeInteger(rule.unitPriceMicros) || rule.unitPriceMicros <= 0) {
    throw new BillingError("视频模型价格必须为正整数，零价格需要显式免费策略", 402);
  }
  let minimaxH3Pricing: ReturnType<typeof resolveMiniMaxH3ReservationPricing> | null = null;
  if (provider === "autodl") {
    if (!isAutoDLH3Model(input.model) || rule.unit !== "video" || !rule.ruleConfig?.autodlH3Pricing) {
      throw new BillingError("AutoDL H3 必须配置专属的输出秒定价", 402);
    }
    // Reject unsupported media/options before reservation or the durable POST marker.
    projectVideoRelayProviderRequest("autodl", { ...input.requestPayload, model: input.model });
  }
  if (provider === "minimax") {
    if (rule.unit !== "video") {
      throw new BillingError("MiniMax H3 必须使用 video 单位和终态 usage 结算", 402);
    }
    try {
      minimaxH3Pricing = resolveMiniMaxH3ReservationPricing({
        model: input.model,
        requestPayload: input.requestPayload,
        ruleConfig: rule.ruleConfig,
      });
    } catch (caught) {
      throw new BillingError(
        `MiniMax H3 定价配置无效: ${caught instanceof Error ? caught.message : "unknown"}`,
        402,
      );
    }
  }
  const evaluatedAt = Date.now();
  let selectedPricing;
  try {
    selectedPricing = resolveVideoInputPricing({
      ruleConfig: rule.ruleConfig,
      requestPayload: { ...input.requestPayload, model: input.model },
      baseUnitPriceMicros: minimaxH3Pricing?.unitPriceMicros ?? rule.unitPriceMicros,
      evaluatedAt,
    });
  } catch (caught) {
    throw new BillingError(
      `视频输入分档定价配置无效: ${caught instanceof Error ? caught.message : "unknown"}`,
      402,
    );
  }
  const referenceDurations = canonicalRequest && canonicalRequest.inputs.some((item) => item.mediaType === "video")
    ? await resolveVideoReferenceDurations({ database: db, workspaceId: input.workspaceId,
      projectId: Number(input.projectId), request: canonicalRequest })
    : undefined;
  if (input.model === BYTEPLUS_SEEDANCE_25_MODEL_ID && canonicalRequest) {
    const videos = canonicalRequest.inputs.filter((item) => item.mediaType === "video");
    if (videos.length && (!referenceDurations || referenceDurations.count !== videos.length)) {
      throw new BillingError("海外 Seedance 2.5 参考视频需可读取且总时长不超过 30 秒", 422);
    }
    if (["edit", "extend"].includes(canonicalRequest.operation)
      && (!referenceDurations?.sourceSeconds
        || referenceDurations.sourceSeconds < (canonicalRequest.operation === "edit" ? 4 : 2)
        || referenceDurations.sourceSeconds > 30.05)) {
      throw new BillingError("视频编辑原片须为 4–30 秒，延长原片须为 2–30 秒", 422);
    }
    if (canonicalRequest.operation === "edit" && videos.length
      && (!referenceDurations?.minimumSeconds || referenceDurations.minimumSeconds < 4)) {
      throw new BillingError("视频编辑的每段参考视频须为 4–30 秒，视频总时长不超过 30 秒", 422);
    }
  }
  const tokenReservation = rule.unit === "token" && selectedPricing.reservationUpperBoundTokens != null
    ? resolveVideoTokenReservation({
      model: String(input.model || ""), ruleConfig: rule.ruleConfig,
      requestPayload: input.requestPayload,
      configuredUpperBoundTokens: selectedPricing.reservationUpperBoundTokens,
      referenceDurations,
    }) : null;
  if (canonicalRequest) assertRequestVideoTokenEstimate(tokenReservation);
  const reservationUnits = rule.unit === "token"
    ? tokenReservation?.reservationTokens ?? null
    : 1;
  if (reservationUnits == null) {
    throw new BillingError(
      "视频 token 计费必须配置正整数 ruleConfig.reservationUpperBoundTokens，禁止猜测预扣 token 数",
      402,
    );
  }
  const timePricing = resolveTimePricing(rule.ruleConfig, evaluatedAt);
  const effectivePricing = {
    ...selectedPricing,
    multiplier: selectedPricing.multiplier * timePricing.multiplier,
  };
  const generationReservationCostMicros = calculateResolvedVideoInputCost(
    effectivePricing,
    reservationUnits,
  );
  const valueVideoPricingSnapshot = await resolveFanjinValueVideoPricingSnapshot({
    database: db,
    workspaceId: input.workspaceId,
    publicModel: String(input.model || "").trim(),
    ruleConfig: rule.ruleConfig,
    requestPayload: input.requestPayload,
    generationReservationCostMicros,
  });
  if (valueVideoPricingSnapshot && rule.unit !== "token") {
    throw new BillingError(
      "繁境特价版生成成本必须使用火山终态 usage.completion_tokens 结算",
      402,
    );
  }
  const costMicros = ceilGuChargeMicros(valueVideoPricingSnapshot?.reservationCostMicros
    ?? generationReservationCostMicros);
  if (!Number.isSafeInteger(costMicros) || costMicros <= 0) {
    throw new BillingError("视频模型结算价格必须大于零，已拒绝调用上游", 402);
  }
  return {
    rule,
    unit: rule.unit,
    pricingRuleBaseUnitPriceMicros: rule.unitPriceMicros,
    unitPriceMicros: effectivePricing.unitPriceMicros,
    multiplier: effectivePricing.multiplier,
    minimumMicros: effectivePricing.minimumMicros,
    videoInputPricingTier: effectivePricing.tier,
    videoInputPricingConfigured: effectivePricing.configured,
    reservationUnits,
    costMicros,
    valueVideoPricingSnapshot,
    priceSnapshot: {
      pricingRuleId: rule.id,
      guChargeRounding: guChargeRoundingVersion,
      pricingRuleUpdatedAt: rule.updateTime,
      endpointType: rule.endpointType,
      provider: rule.provider,
      model: rule.model,
      unit: rule.unit,
      pricingRuleBaseUnitPriceMicros: rule.unitPriceMicros,
      unitPriceMicros: effectivePricing.unitPriceMicros,
      multiplier: effectivePricing.multiplier,
      baseMultiplier: selectedPricing.multiplier,
      minimumMicros: effectivePricing.minimumMicros,
      timePricing,
      videoInputPricingTier: effectivePricing.tier,
      videoInputPricingConfigured: effectivePricing.configured,
      reservationUpperBoundTokens: rule.unit === "token" ? reservationUnits : null,
      ...(tokenReservation ? { tokenReservation } : {}),
      resolution: String(input.requestPayload.resolution || ""),
      reservationUnits,
      ...(valueVideoPricingSnapshot
        ? { fanjinValueVideoPricing: valueVideoPricingSnapshot }
        : {}),
      ...(minimaxH3Pricing
        ? { minimaxH3Pricing: minimaxH3Pricing.snapshot }
        : {}),
      costMicros,
      currency: rule.currency,
    },
  };
}

async function settleMiniMaxH3TerminalBilling(input: {
  task: RelayTask;
  channel: RelayChannel;
  payload: Record<string, unknown>;
  terminalStatus: RelayTaskStatus;
  providerResponseOk: boolean;
  reservation: VideoBillingReservation;
}): Promise<boolean> {
  const { task, channel, payload, terminalStatus, providerResponseOk, reservation } = input;
  if (terminalStatus !== "succeeded") {
    throw new BillingError("MiniMax H3 只有成功终态可以自动结算", 409);
  }
  if (reservation.remainingMicros === 0 && ["charged", "free"].includes(reservation.usageStatus)) {
    return true;
  }
  const responseTaskId = String(videoRelayProviderTaskId("minimax", payload) || "").trim();
  const responseStatus = normalizeKnownProviderStatus(videoRelayProviderStatus("minimax", payload));
  if (
    !providerResponseOk
    || channel.provider !== "minimax"
    || !task.providerTaskId
    || responseTaskId !== task.providerTaskId
    || responseStatus !== terminalStatus
  ) {
    await markVideoBillingPending(task, channel, "minimax_h3_terminal_response_untrusted", {
      providerTaskId: task.providerTaskId,
      providerTerminalStatus: terminalStatus,
      providerResponseOk,
      responseTaskIdMatches: Boolean(task.providerTaskId && responseTaskId === task.providerTaskId),
      responseStatusMatches: responseStatus === terminalStatus,
      authoritativeUsagePath: "task.usage",
    });
    return false;
  }

  const priceSnapshot = reservation.metadata.priceSnapshot;
  const minimaxH3Pricing = priceSnapshot
    && typeof priceSnapshot === "object"
    && !Array.isArray(priceSnapshot)
    ? (priceSnapshot as Record<string, unknown>).minimaxH3Pricing
    : null;
  let actual;
  try {
    actual = calculateMiniMaxH3TerminalCost({
      snapshot: minimaxH3Pricing,
      providerPayload: payload,
    });
    const timeMultiplier = Number(
      (priceSnapshot as Record<string, unknown> | null)?.timePricing
      && typeof (priceSnapshot as Record<string, unknown>).timePricing === "object"
      && !Array.isArray((priceSnapshot as Record<string, unknown>).timePricing)
        ? ((priceSnapshot as Record<string, unknown>).timePricing as Record<string, unknown>).multiplier
        : 1,
    );
    actual = {
      ...actual,
      costMicros: applyGuChargeRounding(multiplyPricingMicros(actual.costMicros, timeMultiplier, "costMicros"), reservation.metadata),
    };
  } catch (caught) {
    await markVideoBillingPending(task, channel, "minimax_h3_terminal_usage_invalid", {
      providerTaskId: task.providerTaskId,
      providerTerminalStatus: terminalStatus,
      authoritativeUsagePath: "task.usage",
      reason: caught instanceof Error ? caught.message : "unknown",
    });
    return false;
  }
  if (actual.costMicros > reservation.amountMicros) {
    await markVideoBillingPending(task, channel, "minimax_h3_terminal_cost_exceeds_reservation", {
      providerTaskId: task.providerTaskId,
      actualCostMicros: actual.costMicros,
      reservedCostMicros: reservation.amountMicros,
    });
    return false;
  }
  await settleApiTaskReservation({
    workspaceId: reservation.workspaceId,
    reservationId: reservation.id,
    actualCostMicros: actual.costMicros,
    units: 1,
    unit: reservation.unit,
    provider: channel.provider,
    channelId: channel.id,
    requestId: reservation.requestId,
    idempotencyKey: reservation.billingKey,
    description: `MiniMax H3 terminal usage captured: ${task.id}`,
    metadata: {
      billingKey: reservation.billingKey,
      priceSnapshot: reservation.metadata.priceSnapshot || null,
      providerTaskId: task.providerTaskId,
      providerTerminalStatus: terminalStatus,
      authoritativeUsagePath: "task.usage",
      outputSeconds: actual.outputSeconds,
      inputVideoSeconds: actual.inputVideoSeconds,
      inputImageCount: actual.inputImageCount,
      settlementEvidenceComplete: true,
      settlementUnit: reservation.unit,
    },
    mutationFence: relayVideoBillingMutationFence(task),
    trustedBeforeCommit: storedPrivateValidationBudget(task)
      ? async (transaction, settlement) => {
          const binding = storedPrivateValidationBudget(task);
          if (!binding) throw new BillingError("私有验证预算 binding 在终态结算边界消失", 409);
          await settleReleaseFullMaintenancePrivateValidationBudgetSlotInTransaction(
            transaction,
            { binding, taskId: task.id, settlement },
          );
        }
      : undefined,
  });
  await db("o_relay_task").where({ id: task.id }).update({
    costMicros: actual.costMicros,
    updateTime: Date.now(),
  });
  return true;
}

function assertSeedance25PricingPlan(
  binding: TrustedVideoProviderAdapter,
  channel: RelayChannel,
  pricing: VideoPricingPlan,
  outputResolution: unknown,
): void {
  if (binding.providerModel === BYTEPLUS_SEEDANCE_25_MODEL_ID) {
    let readback;
    try {
      readback = assertBytePlusSeedance25PricingRuleReadback({
        provider: pricing.rule.provider, model: pricing.rule.model,
        unit: pricing.rule.unit, currency: pricing.rule.currency,
        baseUnitPriceMicros: pricing.rule.unitPriceMicros,
        ruleConfig: pricing.rule.ruleConfig,
      });
    } catch {
      throw canonicalVideoBindingError("byteplus_seedance25_pricing_readback_invalid", "海外 Seedance 2.5 定价读回无效");
    }
    const resolution = String(outputResolution || "720p").trim().toLowerCase() as keyof typeof readback.resolutionTokenPrices;
    const tier = readback.resolutionTokenPrices[resolution];
    const expectedPrice = pricing.videoInputPricingTier === "with_video_input"
      ? tier?.withVideoInput : tier?.withoutVideoInput;
    const timePricing = pricing.priceSnapshot.timePricing;
    const timePricingRecord = timePricing && typeof timePricing === "object" && !Array.isArray(timePricing)
      ? timePricing as Record<string, unknown> : null;
    const baseMultiplier = Number(pricing.priceSnapshot.baseMultiplier);
    const timeMultiplier = Number(timePricingRecord?.multiplier);
    const timeMultiplierBps = Number(timePricingRecord?.multiplierBps);
    const timePricingBindingValid = Boolean(timePricingRecord
      && Number.isSafeInteger(timeMultiplierBps) && timeMultiplierBps > 0
      && timeMultiplier === timeMultiplierBps / 10_000
      && baseMultiplier === 1 && pricing.multiplier === baseMultiplier * timeMultiplier);
    if (channel.provider !== "volcano" || JSON.stringify(readback) !== JSON.stringify(binding.pricingReadback)
      || pricing.unit !== "token" || pricing.videoInputPricingConfigured !== true
      || pricing.unitPriceMicros !== expectedPrice || !timePricingBindingValid || pricing.minimumMicros !== 0
      || Number((pricing.priceSnapshot.tokenReservation as Record<string, unknown> | undefined)?.configuredUpperBoundTokens
        ?? pricing.reservationUnits) !== readback.reservationUpperBoundTokens
      || pricing.reservationUnits > readback.reservationUpperBoundTokens) {
      throw canonicalVideoBindingError("byteplus_seedance25_pricing_binding_mismatch", "海外 Seedance 2.5 价格、分档或预占与已读回规则不一致");
    }
    return;
  }
  let readback: Seedance25PricingReadbackBinding;
  try {
    readback = assertSeedance25PricingRuleReadback({
      provider: pricing.rule.provider,
      model: pricing.rule.model,
      unit: pricing.rule.unit,
      currency: pricing.rule.currency,
      baseUnitPriceMicros: pricing.rule.unitPriceMicros,
      ruleConfig: pricing.rule.ruleConfig,
    });
  } catch {
    throw canonicalVideoBindingError(
      "seedance25_pricing_readback_invalid",
      "Seedance 2.5 当前路由未读回完整的分辨率与参考视频定价",
    );
  }
  const resolution = String(outputResolution || "720p").trim().toLowerCase();
  const resolutionPrices = readback.resolutionTokenPrices[
    resolution as keyof typeof readback.resolutionTokenPrices
  ];
  const expectedTierPrice = pricing.videoInputPricingTier === "with_video_input"
    ? resolutionPrices?.withVideoInput
    : resolutionPrices?.withoutVideoInput;
  const timePricing = pricing.priceSnapshot.timePricing;
  const timePricingRecord = timePricing
    && typeof timePricing === "object"
    && !Array.isArray(timePricing)
      ? timePricing as Record<string, unknown>
      : null;
  const baseMultiplier = Number(pricing.priceSnapshot.baseMultiplier);
  const timeMultiplier = Number(timePricingRecord?.multiplier);
  const timeMultiplierBps = Number(timePricingRecord?.multiplierBps);
  const timePricingBindingValid = Boolean(
    timePricingRecord
    && Number.isSafeInteger(timeMultiplierBps)
    && timeMultiplierBps > 0
    && timeMultiplier === timeMultiplierBps / 10_000
    && Number.isFinite(baseMultiplier)
    && baseMultiplier === 1
    && pricing.multiplier === baseMultiplier * timeMultiplier,
  );
  if (
    channel.provider !== readback.provider
    || JSON.stringify(readback) !== JSON.stringify(binding.pricingReadback)
    || pricing.unit !== "token"
    || pricing.videoInputPricingConfigured !== true
    || pricing.unitPriceMicros !== expectedTierPrice
    || !timePricingBindingValid
    || pricing.minimumMicros !== 0
    || Number((pricing.priceSnapshot.tokenReservation as Record<string, unknown> | undefined)?.configuredUpperBoundTokens
      ?? pricing.reservationUnits) !== readback.reservationUpperBoundTokens
    || pricing.reservationUnits > readback.reservationUpperBoundTokens
  ) {
    throw canonicalVideoBindingError(
      "seedance25_pricing_binding_mismatch",
      "Seedance 2.5 Adapter 定价绑定与当前路由、请求分档或预占上限不一致",
    );
  }
}

function assertVideoBillingAuthorization(input: {
  authorization: RelayVideoBillingAuthorization;
  pricingInput: CreateRelayTaskInput;
  channel: RelayChannel;
  pricing: VideoPricingPlan;
}): void {
  const authorization = input.authorization;
  const rule = input.pricing.rule;
  const requestedModel = String(input.pricingInput.model || "").trim();
  const pricedModel = rule.model == null ? null : String(rule.model);
  const reservationUpperBoundTokens = input.pricing.unit === "token"
    ? input.pricing.reservationUnits
    : null;
  const authorizationValuePricing = authorization.valueVideoPricingSnapshot ?? null;
  const currentValuePricing = input.pricing.valueVideoPricingSnapshot;
  if (
    authorization.version !== "agent-video-billing-authorization/v1"
    || !authorization.pricingRuleId
    || !Number.isSafeInteger(authorization.pricingRuleUpdatedAt)
    || authorization.pricingRuleUpdatedAt < 0
    || !authorization.provider
    || !authorization.requestedModel
    || !["task", "video", "token"].includes(authorization.unit)
    || !Number.isSafeInteger(authorization.pricingRuleBaseUnitPriceMicros)
    || authorization.pricingRuleBaseUnitPriceMicros <= 0
    || !Number.isSafeInteger(authorization.unitPriceMicros)
    || authorization.unitPriceMicros <= 0
    || !Number.isFinite(authorization.multiplier)
    || authorization.multiplier <= 0
    || !Number.isSafeInteger(authorization.minimumMicros)
    || authorization.minimumMicros < 0
    || !["with_video_input", "without_video_input"].includes(authorization.videoInputPricingTier)
    || typeof authorization.videoInputPricingConfigured !== "boolean"
    || !Number.isSafeInteger(authorization.reservationUnits)
    || authorization.reservationUnits <= 0
    || authorization.reservationUpperBoundTokens !== reservationUpperBoundTokens
    || !Number.isSafeInteger(authorization.reservationCostMicros)
    || authorization.reservationCostMicros <= 0
    || !Number.isSafeInteger(authorization.maximumCostMicros)
    || authorization.maximumCostMicros <= 0
    || authorization.pricingRuleId !== rule.id
    || authorization.pricingRuleUpdatedAt !== rule.updateTime
    || authorization.provider !== input.channel.provider
    || authorization.provider !== rule.provider
    || authorization.requestedModel !== requestedModel
    || authorization.pricedModel !== pricedModel
    || authorization.unit !== input.pricing.unit
    || authorization.pricingRuleBaseUnitPriceMicros !== rule.unitPriceMicros
    || authorization.unitPriceMicros !== input.pricing.unitPriceMicros
    || authorization.multiplier !== input.pricing.multiplier
    || authorization.minimumMicros !== input.pricing.minimumMicros
    || authorization.videoInputPricingTier !== input.pricing.videoInputPricingTier
    || authorization.videoInputPricingConfigured !== input.pricing.videoInputPricingConfigured
    || authorization.reservationUnits !== input.pricing.reservationUnits
    || authorization.reservationCostMicros !== input.pricing.costMicros
    || authorization.maximumCostMicros !== input.pricing.costMicros
    || stableStringifyJson(authorizationValuePricing)
      !== stableStringifyJson(currentValuePricing)
    || authorization.currency !== rule.currency
  ) {
    throw new BillingError("视频计费授权与当前路由或定价快照不一致，请重新报价", 409);
  }
}

function assertTrustedVideoBillingAuthorizationInput(
  authorization: RelayVideoBillingAuthorization,
  input: CreateRelayTaskInput,
): void {
  const expectedRequestId = authorization.operation === "submit"
    ? `agent-video-submit:${authorization.quoteId}`
    : `agent-video-retry:${authorization.quoteId}`;
  const tokenReservationValid = authorization.unit === "token"
    ? Number.isSafeInteger(authorization.reservationUpperBoundTokens)
      && Number(authorization.reservationUpperBoundTokens) > 0
      && authorization.reservationUpperBoundTokens === authorization.reservationUnits
    : authorization.reservationUpperBoundTokens === null
      && authorization.reservationUnits === 1;
  const managedValueOffer = isFanjinValueVideoModel(authorization.requestedModel);
  const valuePricingSnapshot = authorization.valueVideoPricingSnapshot ?? null;
  let valuePricingBindingValid = valuePricingSnapshot === null;
  if (managedValueOffer && valuePricingSnapshot !== null) {
    try {
      const parsed = parseFanjinValueVideoPricingSnapshot(valuePricingSnapshot);
      valuePricingBindingValid = parsed.publicModel === authorization.requestedModel
        && parsed.reservationCostMicros === authorization.reservationCostMicros;
    } catch {
      valuePricingBindingValid = false;
    }
  }
  if (
    authorization.version !== "agent-video-billing-authorization/v1"
    || !["submit", "retry"].includes(authorization.operation)
    || !authorization.quoteId
    || !/^[a-f0-9]{64}$/.test(authorization.pricingDigest)
    || authorization.endpointType !== "video_generation"
    || !authorization.workspaceId
    || !Number.isSafeInteger(authorization.projectId)
    || authorization.projectId <= 0
    || !authorization.pricingRuleId
    || !Number.isSafeInteger(authorization.pricingRuleUpdatedAt)
    || authorization.pricingRuleUpdatedAt < 0
    || !authorization.provider
    || !authorization.requestedModel
    || authorization.requestUnits !== 1
    || !["task", "video", "token"].includes(authorization.unit)
    || !Number.isSafeInteger(authorization.pricingRuleBaseUnitPriceMicros)
    || authorization.pricingRuleBaseUnitPriceMicros <= 0
    || !Number.isSafeInteger(authorization.unitPriceMicros)
    || authorization.unitPriceMicros <= 0
    || !Number.isFinite(authorization.multiplier)
    || authorization.multiplier <= 0
    || !Number.isSafeInteger(authorization.minimumMicros)
    || authorization.minimumMicros < 0
    || !["with_video_input", "without_video_input"].includes(authorization.videoInputPricingTier)
    || typeof authorization.videoInputPricingConfigured !== "boolean"
    || !Number.isSafeInteger(authorization.reservationUnits)
    || authorization.reservationUnits <= 0
    || !tokenReservationValid
    || !valuePricingBindingValid
    || !Number.isSafeInteger(authorization.reservationCostMicros)
    || authorization.reservationCostMicros <= 0
    || !Number.isSafeInteger(authorization.maximumCostMicros)
    || authorization.maximumCostMicros <= 0
    || authorization.reservationCostMicros > authorization.maximumCostMicros
    || authorization.currency !== "GU"
    || input.endpointType !== authorization.endpointType
    || String(input.workspaceId || "") !== authorization.workspaceId
    || Number(input.projectId) !== authorization.projectId
    || String(input.provider || "") !== authorization.provider
    || String(input.model || "") !== authorization.requestedModel
    || videoInputPricingTierForRequestPayload(input.requestPayload)
      !== authorization.videoInputPricingTier
    || String(input.requestId || "") !== expectedRequestId
  ) {
    throw new BillingError("Agent 视频计费授权结构或任务绑定无效", 409);
  }
}

function videoBillingAuthorizationConflict(message: string): never {
  const error: any = new Error(message);
  error.status = 409;
  error.code = "relay_video_billing_authorization_conflict";
  throw error;
}

function relayIdempotencyInProgress(message: string): never {
  const error: any = new Error(message);
  error.status = 409;
  error.code = "idempotency_in_progress";
  throw error;
}

function approvedVideoPricingPlan(
  authorization: RelayVideoBillingAuthorization,
): VideoPricingPlan {
  const valueVideoPricingSnapshot = authorization.valueVideoPricingSnapshot ?? null;
  const priceSnapshot = {
    pricingRuleId: authorization.pricingRuleId,
    pricingRuleUpdatedAt: authorization.pricingRuleUpdatedAt,
    endpointType: authorization.endpointType,
    provider: authorization.provider,
    model: authorization.pricedModel,
    unit: authorization.unit,
    pricingRuleBaseUnitPriceMicros: authorization.pricingRuleBaseUnitPriceMicros,
    unitPriceMicros: authorization.unitPriceMicros,
    multiplier: authorization.multiplier,
    minimumMicros: authorization.minimumMicros,
    videoInputPricingTier: authorization.videoInputPricingTier,
    videoInputPricingConfigured: authorization.videoInputPricingConfigured,
    reservationUpperBoundTokens:
      authorization.reservationUpperBoundTokens,
    reservationUnits: authorization.reservationUnits,
    ...(valueVideoPricingSnapshot
      ? { fanjinValueVideoPricing: valueVideoPricingSnapshot }
      : {}),
    costMicros: authorization.reservationCostMicros,
    currency: authorization.currency,
  };
  return {
    rule: {
      id: authorization.pricingRuleId,
      name: "approved-agent-video-quote",
      scope: "approved_quote",
      workspaceId: authorization.workspaceId,
      endpointType: authorization.endpointType,
      provider: authorization.provider,
      model: authorization.pricedModel,
      unit: authorization.unit,
      unitPriceMicros: authorization.pricingRuleBaseUnitPriceMicros,
      currency: authorization.currency,
      ruleConfig: {
        multiplier: authorization.multiplier,
        minimumMicros: authorization.minimumMicros,
        ...(authorization.reservationUpperBoundTokens == null
          ? {}
          : {
              reservationUpperBoundTokens:
                authorization.reservationUpperBoundTokens,
            }),
      },
      disabled: 0,
      createTime: authorization.pricingRuleUpdatedAt,
      updateTime: authorization.pricingRuleUpdatedAt,
    },
    unit: authorization.unit,
    pricingRuleBaseUnitPriceMicros: authorization.pricingRuleBaseUnitPriceMicros,
    unitPriceMicros: authorization.unitPriceMicros,
    multiplier: authorization.multiplier,
    minimumMicros: authorization.minimumMicros,
    videoInputPricingTier: authorization.videoInputPricingTier,
    videoInputPricingConfigured: authorization.videoInputPricingConfigured,
    reservationUnits: authorization.reservationUnits,
    costMicros: authorization.reservationCostMicros,
    valueVideoPricingSnapshot,
    priceSnapshot,
  };
}

async function recoverPrivateValidationBudgetReservation(input: {
  task: RelayTask;
  relayInput: CreateRelayTaskInput;
  binding: TrustedPrivateValidationBudget;
  billingAuthorization: RelayVideoBillingAuthorization | null;
}): Promise<RelayTask> {
  const existing = await readVideoBillingReservation(input.task, false);
  if (existing && hasVideoDispatchEvidence(input.task)) return input.task;
  if (!existing && hasVideoDispatchEvidence(input.task)) {
    throw canonicalVideoBindingError(
      "private_validation_budget_recovery_dispatch_conflict",
      "私有验证任务已有派发证据但缺少冻结流水，禁止自动补扣",
    );
  }
  const claimed = await claimRelayTask(input.task);
  if (!claimed) {
    relayIdempotencyInProgress("私有验证任务正在恢复 exact 计费预扣");
  }
  try {
    let reservation = await readVideoBillingReservation(claimed, false);
    if (!reservation) {
      const channelRow = claimed.channelId
        ? await db("o_provider_channel")
            .where({ id: claimed.channelId, disabled: 0 })
            .first()
        : null;
      if (!channelRow) {
        throw canonicalVideoBindingError(
          "private_validation_budget_recovery_channel_missing",
          "私有验证任务恢复时 exact 供应商通道不可用",
        );
      }
      const channel = parseRelayChannel(channelRow);
      if (
        channel.id !== claimed.channelId
        || channel.provider !== claimed.provider
        || channel.endpointType !== "video_generation"
      ) {
        throw canonicalVideoBindingError(
          "private_validation_budget_recovery_channel_mismatch",
          "私有验证任务恢复时供应商通道身份已变化",
        );
      }
      const videoPlan = restoreVideoResolutionPlanFromInternal(
        claimed.resultPayload,
        claimed.requestPayload,
      );
      if (videoPlan.invalidResolution) {
        throw canonicalVideoBindingError(
          "private_validation_budget_recovery_plan_invalid",
          "私有验证任务恢复时分辨率计划无效",
        );
      }
      assertPrivateValidationBudgetSingleProviderTaskPlan(
        input.binding,
        videoPlan,
      );
      const resolvedPricing = input.billingAuthorization
        ? approvedVideoPricingPlan(input.billingAuthorization)
        : await resolveVideoPricingPlan(input.relayInput, channel);
      const pricingCheckpoint = privateValidationBudgetPricingCheckpointFromInternal(
        claimed.resultPayload.internal,
      );
      const pricing = pricingCheckpoint
        ? restorePrivateValidationBudgetPricingPlan({
            resolvedPricing,
            checkpoint: pricingCheckpoint,
          })
        : resolvedPricing;
      if (input.billingAuthorization) {
        assertVideoBillingAuthorization({
          authorization: input.billingAuthorization,
          pricingInput: input.relayInput,
          channel,
          pricing,
        });
      }
      const pricingEvidenceSha256 = privateValidationBudgetPricingEvidenceSha256({
        binding: input.binding,
        relayInput: input.relayInput,
        channel,
        pricing,
      });
      if (
        pricingCheckpoint
        && pricingEvidenceSha256 !== pricingCheckpoint.pricingEvidenceSha256
      ) {
        privateValidationBudgetPricingCheckpointError(
          "Relay 私有验证预算价格检查点未通过预算证据哈希校验",
        );
      }
      await reserveReleaseFullMaintenancePrivateValidationBudgetSlotGu({
        binding: input.binding,
        requestId: String(input.relayInput.requestId || ""),
        provider: channel.provider,
        channelId: channel.id,
        model: String(input.relayInput.model || ""),
        reservationGuMicros: pricing.costMicros,
        pricingEvidenceSha256,
      });
      await reserveVideoBilling(
        claimed.id,
        input.relayInput,
        channel,
        pricing,
        videoPlan,
        input.billingAuthorization,
      );
      reservation = await readVideoBillingReservation(claimed, false);
      if (!reservation) {
        throw new BillingError("私有验证任务恢复预扣后缺少冻结流水", 500);
      }
    }
    // The billing freeze and request-quota reservation are separate durable
    // transactions. Re-run this exact-idempotent check even when the freeze
    // already existed, so a hard kill between them cannot strand an active
    // task without quota or create a second quota reservation.
    await reserveRelayTaskApiQuota((await getRelayTask(claimed.id)) || claimed);
    const releasedAt = Date.now();
    const released = await db("o_relay_task")
      .where({
        id: claimed.id,
        status: claimed.status,
        leaseOwner: claimed.leaseOwner,
        leaseExpiresAt: claimed.leaseExpiresAt,
      })
      .where("leaseExpiresAt", ">", releasedAt)
      .update({
        updateTime: releasedAt,
        ...releaseLeasePatch(),
      });
    if (Number(released || 0) !== 1) {
      relayIdempotencyInProgress(
        "私有验证任务 exact 预扣已完成，正在交接给 Worker",
      );
    }
    const recovered = await getRelayTask(claimed.id);
    if (!recovered) {
      throw canonicalVideoBindingError(
        "private_validation_budget_recovery_task_missing",
        "私有验证任务恢复预扣后不存在",
      );
    }
    return recovered;
  } catch (error) {
    const current = (await getRelayTask(claimed.id)) || claimed;
    let reservation: VideoBillingReservation | null = null;
    try {
      reservation = await readVideoBillingReservation(current, false);
    } catch {
      reservation = null;
    }
    if (reservation) {
      await failRelayTask(
        current,
        "私有验证任务恢复预扣失败，已停止上游派发",
      );
    } else {
      const failedAt = Date.now();
      await db.transaction(async (transaction) => {
        await abortReleaseFullMaintenancePrivateValidationBudgetSlotBeforeBillingInTransaction(
          transaction,
          {
            binding: input.binding,
            taskId: current.id,
            reason: "reservation_recovery_failed",
            now: failedAt,
          },
        );
        const affected = await transaction("o_relay_task")
          .where({
            id: current.id,
            status: current.status,
            leaseOwner: current.leaseOwner,
            leaseExpiresAt: current.leaseExpiresAt,
          })
          .where("leaseExpiresAt", ">", failedAt)
          .update({
            status: "failed",
            providerPayload: stringifyJson({
              ...(current.providerPayload || {}),
              privateValidationBudgetRecovery: {
                state: "released_prebilling",
                providerRequestStarted: false,
                failedAt,
              },
            }),
            resultPayload: stringifyJson(mergePersistedVideoPlan(current, {
              message: "私有验证任务恢复预扣失败",
            })),
            errorMessage: "私有验证任务恢复预扣失败",
            updateTime: failedAt,
            completedAt: failedAt,
            ...releaseLeasePatch(),
          });
        if (Number(affected || 0) !== 1) {
          throw canonicalVideoBindingError(
            "private_validation_budget_recovery_fence_lost",
            "私有验证任务恢复失败时 mutation fence 已变化",
          );
        }
      });
    }
    throw error;
  }
}

async function recoverAuthorizedRelayReservation(input: {
  task: RelayTask;
  relayInput: CreateRelayTaskInput;
  authorization: RelayVideoBillingAuthorization;
}): Promise<RelayTask> {
  if (hasVideoDispatchEvidence(input.task)) {
    videoBillingAuthorizationConflict(
      "既有视频任务已有派发证据但缺少冻结流水，禁止自动补扣",
    );
  }
  const claimed = await claimRelayTask(input.task);
  if (!claimed) {
    relayIdempotencyInProgress("既有视频任务仍在完成计费预扣");
  }
  try {
    let reservation = await readVideoBillingReservation(claimed, false);
    if (!reservation) {
      const channelRow = claimed.channelId
        ? await db("o_provider_channel").where({ id: claimed.channelId }).first()
        : null;
      if (!channelRow) {
        videoBillingAuthorizationConflict(
          "既有视频任务缺少审批绑定的供应商通道",
        );
      }
      const channel = parseRelayChannel(channelRow);
      if (
        channel.id !== claimed.channelId
        || channel.provider !== input.authorization.provider
        || channel.endpointType !== input.authorization.endpointType
      ) {
        videoBillingAuthorizationConflict(
          "既有视频任务的供应商通道与审批计费授权不一致",
        );
      }
      const videoPlan = restoreVideoResolutionPlanFromInternal(
        claimed.resultPayload,
        claimed.requestPayload,
      );
      if (videoPlan.invalidResolution) {
        videoBillingAuthorizationConflict(
          "既有视频任务的分辨率执行计划无效",
        );
      }
      await reserveVideoBilling(
        claimed.id,
        input.relayInput,
        channel,
        approvedVideoPricingPlan(input.authorization),
        videoPlan,
        input.authorization,
      );
      reservation = await readVideoBillingReservation(claimed, false);
      if (!reservation) {
        throw new BillingError("视频任务恢复预扣后缺少冻结流水", 500);
      }
      await reserveRelayTaskApiQuota((await getRelayTask(claimed.id)) || claimed);
    }
    const releasedAt = Date.now();
    const released = await db("o_relay_task")
      .where({
        id: claimed.id,
        status: claimed.status,
        leaseOwner: claimed.leaseOwner,
        leaseExpiresAt: claimed.leaseExpiresAt,
      })
      .where("leaseExpiresAt", ">", releasedAt)
      .update({
        updateTime: releasedAt,
        ...releaseLeasePatch(),
      });
    if (Number(released || 0) !== 1) {
      relayIdempotencyInProgress(
        "既有视频任务计费预扣已完成，正在交接给 Worker",
      );
    }
    const recovered = await getRelayTask(claimed.id);
    if (!recovered) {
      videoBillingAuthorizationConflict("计费预扣恢复后视频任务不存在");
    }
    return recovered;
  } catch (error) {
    const current = (await getRelayTask(claimed.id)) || claimed;
    const reservation = await readVideoBillingReservation(current, false);
    if (reservation) {
      await failRelayTask(
        current,
        "视频任务恢复预扣失败，已停止上游派发",
      ).catch(() => undefined);
    } else {
      const failedAt = Date.now();
      await db("o_relay_task")
        .where({
          id: claimed.id,
          status: claimed.status,
          leaseOwner: claimed.leaseOwner,
          leaseExpiresAt: claimed.leaseExpiresAt,
        })
        .update({
          status: "failed",
          errorMessage: "视频任务恢复预扣失败",
          updateTime: failedAt,
          completedAt: failedAt,
          ...releaseLeasePatch(),
        });
    }
    throw error;
  }
}

function authorizedVideoReservationBindingMatches(
  task: RelayTask,
  authorization: RelayVideoBillingAuthorization,
  ledger: any,
  usage: any,
): boolean {
  const metadata = parseJsonObject(ledger.metadata);
  const ledgerAuthorization = metadata.billingAuthorization;
  const priceSnapshot = metadata.priceSnapshot
    && typeof metadata.priceSnapshot === "object"
    && !Array.isArray(metadata.priceSnapshot)
    ? metadata.priceSnapshot as Record<string, unknown>
    : {};
  const usageUnits = Number(usage?.units);
  const usageCostMicros = Number(usage?.costMicros);
  const usageKeepsReservation = usageStatusKeepsReservationUnits(String(usage?.status || ""));
  const usageUnitsValid = authorization.unit !== "token"
    ? usageUnits === 1
    : usageKeepsReservation
      ? usageUnits === authorization.reservationUnits
      : Number.isSafeInteger(usageUnits)
        && usageUnits >= 0
        && usageUnits <= authorization.reservationUnits;
  return !(
    !ledgerAuthorization
    || typeof ledgerAuthorization !== "object"
    || Array.isArray(ledgerAuthorization)
    || stableStringifyJson(ledgerAuthorization) !== stableStringifyJson(authorization)
    || Number(ledger.amountMicros) !== authorization.reservationCostMicros
    || Number(ledger.amountMicros) > authorization.maximumCostMicros
    || String(ledger.currency || "") !== authorization.currency
    || String(priceSnapshot.pricingRuleId || "") !== authorization.pricingRuleId
    || String(priceSnapshot.provider || "") !== authorization.provider
    || String(priceSnapshot.unit || "") !== authorization.unit
    || Number(priceSnapshot.reservationUnits) !== authorization.reservationUnits
    || Number(priceSnapshot.costMicros) !== authorization.reservationCostMicros
    || !usage
    || String(usage.workspaceId || "") !== authorization.workspaceId
    || String(usage.taskId || "") !== task.id
    || String(usage.endpointType || "") !== authorization.endpointType
    || String(usage.provider || "") !== authorization.provider
    || String(usage.unit || "") !== authorization.unit
    || !usageUnitsValid
    || !Number.isSafeInteger(usageCostMicros)
    || usageCostMicros < 0
    || usageCostMicros > authorization.maximumCostMicros
  );
}

async function assertIdempotentAuthorizedRelayTask(
  existingTask: any,
  input: CreateRelayTaskInput,
  authorization: RelayVideoBillingAuthorization,
  options: { readOnly?: boolean } = {},
): Promise<RelayTask> {
  let task = assertIdempotentRelayTask(existingTask, input);
  const providerPayload = parseJsonObject(existingTask.providerPayload);
  const identity = providerPayload.identity
    && typeof providerPayload.identity === "object"
    && !Array.isArray(providerPayload.identity)
    ? providerPayload.identity as Record<string, unknown>
    : {};
  const storedAuthorization = identity.billingAuthorization;
  if (
    !storedAuthorization
    || typeof storedAuthorization !== "object"
    || Array.isArray(storedAuthorization)
    || stableStringifyJson(storedAuthorization) !== stableStringifyJson(authorization)
    || String(task.provider || "") !== authorization.provider
    || String(task.model || "") !== authorization.requestedModel
  ) {
    videoBillingAuthorizationConflict("既有视频任务与当前审批计费授权不一致");
  }

  const ledger = await db("o_billing_ledger")
    .where({
      workspaceId: authorization.workspaceId,
      type: "freeze",
      relatedTaskId: task.id,
    })
    .orderBy("createdAt", "desc")
    .first();
  if (!ledger) {
    if (options.readOnly) return task;
    if (isRelayPortraitPreparing(task)) return task;
    if (isActiveStatus(task.status)) {
      task = await recoverAuthorizedRelayReservation({
        task,
        relayInput: input,
        authorization,
      });
      return await assertIdempotentAuthorizedRelayTask(
        await db("o_relay_task").where({ id: task.id }).first(),
        input,
        authorization,
      );
    }
    if (!["failed", "cancelled"].includes(task.status)) {
      videoBillingAuthorizationConflict("既有视频任务缺少审批绑定的冻结流水");
    }
    return task;
  }

  const usage = ledger.relatedUsageId
    ? await db("o_usage_record").where({ id: ledger.relatedUsageId }).first()
    : null;
  if (!authorizedVideoReservationBindingMatches(task, authorization, ledger, usage)) {
    videoBillingAuthorizationConflict("既有视频任务的计费流水与审批上限不一致");
  }
  return task;
}

function usageStatusKeepsReservationUnits(status: string): boolean {
  return !["charged", "free"].includes(status);
}

async function readVideoBillingReservation(
  task: RelayTask,
  requireOpen = true,
  client: Knex | Knex.Transaction = db,
): Promise<VideoBillingReservation | null> {
  if (!task.workspaceId) return null;
  const query = client("o_billing_ledger")
    .where({ workspaceId: task.workspaceId, type: "freeze", relatedTaskId: task.id })
    .orderBy("createdAt", "desc");
  if (requireOpen) query.andWhere("remainingMicros", ">", 0);
  const row = await query.first();
  if (!row) return null;
  const metadata = parseJsonObject(row.metadata);
  const usage = row.relatedUsageId ? await client("o_usage_record").where({ id: row.relatedUsageId }).first() : null;
  if (!usage) throw new BillingError("视频冻结流水未关联用量记录", 500);
  const priceSnapshot = metadata.priceSnapshot && typeof metadata.priceSnapshot === "object" && !Array.isArray(metadata.priceSnapshot)
    ? metadata.priceSnapshot as Record<string, unknown>
    : {};
  const provider = String(usage.provider || metadata.provider || "");
  const channelId = String(usage.channelId || metadata.channelId || "");
  const unit = String(usage.unit || priceSnapshot.unit || "");
  const requestId = String(row.requestId || task.requestId || "");
  const units = Number(usage.units);
  const amountMicros = Number(row.amountMicros || 0);
  const remainingMicros = Number(row.remainingMicros || 0);
  if (
    String(usage.endpointType || "") !== "video_generation" ||
    provider !== String(task.provider || "") ||
    channelId !== String(task.channelId || "") ||
    !["task", "video", "token"].includes(unit) ||
    priceSnapshot.endpointType !== "video_generation" ||
    String(priceSnapshot.provider || "") !== provider ||
    String(priceSnapshot.unit || "") !== unit ||
    Number(priceSnapshot.costMicros || 0) !== amountMicros ||
    !Number.isSafeInteger(amountMicros) ||
    amountMicros <= 0 ||
    !Number.isSafeInteger(remainingMicros) ||
    remainingMicros < 0 ||
    !requestId
  ) {
    throw new BillingError("视频冻结流水与任务身份、供应商、通道或单位不匹配", 409);
  }
  const reservationUnits = unit === "token"
    ? readVideoTokenReservationUpperBound(priceSnapshot)
    : 1;
  const usageUnitsValid = Number.isSafeInteger(units) && units >= 0 && (
    unit !== "token"
      ? units === 1
      : remainingMicros > 0 || usageStatusKeepsReservationUnits(String(usage.status || ""))
        ? units === reservationUnits
        : reservationUnits != null && units <= reservationUnits
  );
  if (reservationUnits == null || !usageUnitsValid) {
    throw new BillingError("视频冻结流水的预扣单位或实际用量无效", 409);
  }
  return {
    id: String(row.id),
    workspaceId: String(task.workspaceId),
    requestId,
    amountMicros,
    remainingMicros,
    usageRecordId: String(row.relatedUsageId),
    units: reservationUnits,
    usageUnits: units,
    unit,
    usageStatus: String(usage.status || ""),
    provider,
    channelId,
    billingKey: String(metadata.billingKey || `relay-video:${task.id}`),
    metadata,
  };
}

type ImmediateVideoBillingResolution = {
  state: "captured" | "released" | "pending_reconcile";
  reconcileJobId: string | null;
};

async function readImmediateVideoBillingResolution(
  task: RelayTask,
): Promise<ImmediateVideoBillingResolution> {
  const reservation = await readVideoBillingReservation(task, false);
  if (!reservation) {
    throw new BillingError("Relay 视频即时终态缺少冻结流水", 500);
  }
  if (
    reservation.remainingMicros === 0
    && ["charged", "free"].includes(reservation.usageStatus)
  ) {
    return { state: "captured", reconcileJobId: null };
  }
  if (
    reservation.remainingMicros === 0
    && reservation.usageStatus === "released"
  ) {
    return { state: "released", reconcileJobId: null };
  }
  if (
    reservation.remainingMicros > 0
    && reservation.usageStatus === "pending_reconcile"
  ) {
    const job = await db("o_billing_reconcile_job")
      .where({
        reservationId: reservation.id,
        workspaceId: reservation.workspaceId,
      })
      .whereIn("status", ["pending", "leased", "manual_required"])
      .select("id")
      .first();
    if (job) {
      return {
        state: "pending_reconcile",
        reconcileJobId: String(job.id),
      };
    }
  }
  throw new BillingError(
    "Relay 视频即时终态没有可核验的账务决策",
    409,
  );
}

function videoSubmission(task: RelayTask): Record<string, unknown> {
  const value = task.providerPayload?.submission;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function publicVideoBillingState(task: RelayTask): "not_started" | "reserved" | "pending_reconcile" | "settled" | "released" {
  if (readRelayPortraitPreparation(task) && !parseJsonObject(task.providerPayload.billing).reservationId
    && !hasVideoDispatchEvidence(task)) return "not_started";
  const state = String(videoSubmission(task).state || "");
  if (state.startsWith("pending_reconcile")) return "pending_reconcile";
  if (state === "captured") return "settled";
  if (state === "released" || state === "definitive_rejected" || state === "cancelled_before_dispatch"
    || state === "portrait_preparation_failed") {
    return "released";
  }
  return "reserved";
}

function hasVideoDispatchEvidence(task: RelayTask): boolean {
  const state = String(videoSubmission(task).state || "");
  return Boolean(
    task.providerTaskId ||
    task.submittedAt ||
    ["dispatch_started", "pending_reconcile_persist_failed", "accepted", "pending_reconcile", "captured"].includes(state),
  );
}

function assertSeedance25CertificationProbeReservation(
  input: CreateRelayTaskInput,
  channel: RelayChannel,
  pricing: VideoPricingPlan,
  videoPlan: VideoResolutionPlan,
  context: Seedance25CertificationProbeInternalContext,
): void {
  if (context.brand !== SEEDANCE_25_CERTIFICATION_PROBE_BRAND) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_brand_invalid",
      "Seedance 2.5 首次认证探针缺少服务器内部 brand",
    );
  }
  const prepared = prepareSeedance25CertificationProbeRequest({
    permit: context.permit,
    pricingReadback: context.pricingReadback,
  });
  const expectedRequestId = scopeRelayRequestId({
    endpointType: "video_generation",
    workspaceId: context.permit.workspaceId,
    projectId: Number(context.permit.projectId),
    principalId: prepared.principalId,
    requestId: prepared.requestId,
    model: SEEDANCE_25_MODEL_ID,
    provider: "volcano",
    requestPayload: prepared.requestPayload,
  });
  if (
    input.endpointType !== "video_generation"
    || input.apiKeyId != null
    || input.workspaceId !== context.permit.workspaceId
    || input.projectId !== Number(context.permit.projectId)
    || input.principalId !== prepared.principalId
    || input.requestId !== expectedRequestId
    || input.model !== SEEDANCE_25_MODEL_ID
    || input.provider !== "volcano"
    || stableStringifyJson(input.requestPayload)
      !== stableStringifyJson(prepared.requestPayload)
    || channel.id !== context.permit.channelId
    || channel.provider !== "volcano"
    || channel.endpointType !== "video_generation"
    || pricing.rule.id !== context.permit.pricingRuleId
    || pricing.videoInputPricingTier !== "without_video_input"
    || pricing.videoInputPricingConfigured !== true
    || pricing.unitPriceMicros !== context.pricingReadback.withoutVideoInputUnitPriceMicros
    || videoPlan.requestedResolution !== "720p"
    || videoPlan.generationResolution !== "720p"
    || videoPlan.finalResolution !== "720p"
    || videoPlan.needsEnhancement
    || videoPlan.invalidResolution
  ) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_reservation_mismatch",
      "Seedance 2.5 首次认证探针不再是固定的 text-only / 720p / 4 秒任务",
    );
  }
  assertSeedance25PricingPlan(
    prepared.relayAdapterBinding,
    channel,
    pricing,
    input.requestPayload.resolution,
  );
}

async function reserveVideoBilling(
  taskId: string,
  input: CreateRelayTaskInput,
  channel: RelayChannel,
  pricing: VideoPricingPlan,
  videoPlan: VideoResolutionPlan,
  billingAuthorization: RelayVideoBillingAuthorization | null,
  billingKeySuffix = "",
  certificationProbeContext: Seedance25CertificationProbeInternalContext | null = null,
): Promise<void> {
  if (certificationProbeContext) {
    const resolved = await resolveSeedance25CertificationProbe(
      certificationProbeContext.permit.probeId,
    );
    assertSeedance25CertificationProbeContext(
      certificationProbeContext,
      resolved,
    );
    assertSeedance25CertificationProbeReservation(
      input,
      channel,
      pricing,
      videoPlan,
      certificationProbeContext,
    );
  } else {
    try {
      await assertCertifiedModelRouteForBilling({
        database: db,
        workspaceId: input.workspaceId,
        endpointType: "video_generation",
        model: input.model || "",
        provider: channel.provider,
        channelId: channel.id,
        requestPayload: input.requestPayload,
        pricingRule: pricing.rule,
      });
    } catch (caught) {
      if (caught instanceof ModelRouteCertificationError) {
        const failure: any = new BillingError(caught.message, caught.statusCode);
        failure.code = caught.code;
        throw failure;
      }
      throw caught;
    }
  }
  // Validate the outgoing controls before creating or repairing a reservation.
  // The task checkpoint was persisted from server options and is revalidated here.
  const checkpointRow = await db("o_relay_task").where({ id: taskId }).first();
  const reservationProviderRequestPayload = checkpointRow && isArkVideoTask(parseRelayTask(checkpointRow))
    ? arkProviderPayload(input.requestPayload) : buildProviderRequestPayload(input, videoPlan, {
    canonicalRequest: checkpointRow
      ? persistedVideoAssetPolicyCheckpoint(parseRelayTask(checkpointRow)).canonicalRequest
      : null,
  });
  const billingKey = `relay-video:${taskId}${billingKeySuffix}`;
  const result = await reserveRelayBilling({
    ...input,
    taskId,
    provider: channel.provider,
    channelId: channel.id,
    units: pricing.reservationUnits,
    unit: pricing.unit,
    costMicros: pricing.costMicros,
    requestId: input.requestId,
    idempotencyKey: `${billingKey}:reserve`,
    metadata: {
      billingKey,
      billingLifecycleState: "reserved",
      endpointType: "video_generation",
      provider: channel.provider,
      channelId: channel.id,
      priceSnapshot: pricing.priceSnapshot,
      membershipResolution: videoPlan.needsEnhancement ? null : videoPlan.generationResolution,
      ...(billingAuthorization ? { billingAuthorization } : {}),
    },
  });
  if (!result.reserved || !result.ledger || result.quotaReserved !== pricing.costMicros) {
    throw new BillingError("视频任务预扣未生成完整冻结流水", 500);
  }
  const taskRow = await db("o_relay_task").where({ id: taskId }).select("providerPayload").first();
  const existingProviderPayload = parseJsonObject(taskRow?.providerPayload);
  await db("o_relay_task").where({ id: taskId }).update({
    providerPayload: stringifyJson({
      ...existingProviderPayload,
      request: reservationProviderRequestPayload,
      billing: {
        reservationId: result.ledger.id,
        usageRecordId: result.usage?.id || null,
        billingKey,
        priceSnapshot: pricing.priceSnapshot,
        ...(billingAuthorization ? { billingAuthorization } : {}),
      },
    }),
    updateTime: Date.now(),
  });
}

async function reserveRelayTaskApiQuota(task: RelayTask): Promise<void> {
  if (!task.apiKeyId) return;
  const requestId = String(task.requestId || "");
  if (!requestId) throw new BillingError("视频 API Key 配额预占缺少 requestId", 500);
  const existing = await db("o_api_key_quota_reservation")
    .where({ apiKeyId: task.apiKeyId, requestId })
    .first();
  let reservedUnits: number;
  if (existing) {
    if (String(existing.status || "") !== "reserved" || Number(existing.units) !== 1) {
      throw new BillingError("视频 API Key 配额预占与任务 requestId 不一致", 409);
    }
    reservedUnits = 1;
  } else {
    reservedUnits = await reserveApiKeyRequestQuota(task.apiKeyId, 1, requestId);
  }
  await db("o_relay_task").where({ id: task.id }).update({ apiQuotaReserved: reservedUnits, updateTime: Date.now() });
}

async function completeRelayTaskApiQuota(task: RelayTask, consumed: boolean): Promise<void> {
  if (!task.apiKeyId) return;
  const requestId = String(task.requestId || "");
  let reservedUnits = task.apiQuotaReserved;
  if (requestId && reservedUnits <= 0) {
    const durableReservation = await db("o_api_key_quota_reservation")
      .where({ apiKeyId: task.apiKeyId, requestId, status: "reserved" })
      .first();
    reservedUnits = Number(durableReservation?.units || 0);
  }
  if (reservedUnits <= 0) return;
  if (!requestId) {
    await completeApiKeyQuota(task.apiKeyId, task.id, consumed);
    return;
  }
  const decision = await completeApiKeyRequestQuota(task.apiKeyId, reservedUnits, consumed, requestId);
  if (decision === "skipped" && task.apiQuotaReserved > 0) {
    await completeApiKeyQuota(task.apiKeyId, task.id, consumed);
    return;
  }
  if (decision !== "deferred") {
    await db("o_relay_task").where({ id: task.id }).update({ apiQuotaReserved: 0, updateTime: Date.now() });
  }
}

async function markVideoBillingDispatched(
  task: RelayTask,
  channel: RelayChannel,
  transaction?: Knex.Transaction,
): Promise<VideoBillingReservation> {
  const reservation = await readVideoBillingReservation(task, true, transaction ?? db);
  if (!reservation || reservation.amountMicros <= 0 || reservation.remainingMicros !== reservation.amountMicros) {
    throw new BillingError("视频任务没有可用的完整冻结额度，禁止调用上游", 409);
  }
  await markApiTaskReservationDispatched({
    workspaceId: reservation.workspaceId,
    reservationId: reservation.id,
    provider: channel.provider,
    channelId: channel.id,
    requestId: reservation.requestId,
    mutationFence: relayVideoBillingMutationFence(task),
    transaction,
    trustedBeforeCommit: storedPrivateValidationBudget(task)
      ? async (transaction, boundary) => {
          const binding = storedPrivateValidationBudget(task);
          if (!binding) throw new BillingError("私有验证预算 binding 在派发边界消失", 409);
          await markReleaseFullMaintenancePrivateValidationBudgetDispatchInTransaction(
            transaction,
            { binding, taskId: task.id, boundary },
          );
        }
      : undefined,
  });
  return reservation;
}

async function markVideoBillingPending(
  task: RelayTask,
  channel: RelayChannel,
  reason: string,
  evidence: Record<string, unknown> = {},
  settlement?: { units: number; unit: string; actualCostMicros: number },
): Promise<void> {
  const reservation = await readVideoBillingReservation(task, false);
  if (!reservation) throw new BillingError("视频任务缺少冻结流水，无法持久化待核账状态", 500);
  if (reservation.remainingMicros === 0) {
    if (["charged", "free"].includes(reservation.usageStatus)) return;
    throw new BillingError("视频冻结流水已结束且并非已扣费，无法标记待核账", 409);
  }
  if (
    settlement
    && (
      !Number.isSafeInteger(settlement.units)
      || settlement.units < 0
      || settlement.units > reservation.units
      || settlement.unit !== reservation.unit
      || !Number.isSafeInteger(settlement.actualCostMicros)
      || settlement.actualCostMicros < 0
      || settlement.actualCostMicros > reservation.amountMicros
    )
  ) {
    throw new BillingError("视频待核账的权威结算数值无效", 409);
  }
  await markApiTaskReservationPendingReconcile({
    workspaceId: reservation.workspaceId,
    reservationId: reservation.id,
    units: settlement?.units ?? reservation.units,
    unit: settlement?.unit ?? reservation.unit,
    actualCostMicros: settlement?.actualCostMicros ?? reservation.amountMicros,
    provider: channel.provider,
    channelId: channel.id,
    reason,
    metadata: {
      billingKey: reservation.billingKey,
      settlementUnit: reservation.unit,
      settlementEvidenceComplete: false,
      priceSnapshot: reservation.metadata.priceSnapshot || null,
      taskId: task.id,
      ...evidence,
    },
    mutationFence: relayVideoBillingMutationFence(task),
    trustedBeforeCommit: storedPrivateValidationBudget(task)
      ? async (transaction, pending) => {
          const binding = storedPrivateValidationBudget(task);
          if (!binding) throw new BillingError("私有验证预算 binding 在待核账边界消失", 409);
          await markReleaseFullMaintenancePrivateValidationBudgetSlotPendingInTransaction(
            transaction,
            {
              binding,
              taskId: task.id,
              reservationId: pending.reservation.id,
              usageRecordId: pending.usage.id,
              reason: pending.reason,
              actualGuMicros: pending.actualCostMicros,
            },
          );
        }
      : undefined,
  });
  const [job, usage] = await Promise.all([
    db("o_billing_reconcile_job").where({ reservationId: reservation.id }).first(),
    db("o_usage_record").where({ id: reservation.usageRecordId }).first(),
  ]);
  if (!job || String(usage?.status || "") !== "pending_reconcile") {
    const latest = await readVideoBillingReservation(task, false);
    if (latest?.remainingMicros === 0 && ["charged", "free"].includes(latest.usageStatus)) return;
    throw new BillingError("视频待核账状态未完整持久化，任务不能进入终态", 500);
  }
}

async function settleVideoSubmissionBilling(task: RelayTask, channel: RelayChannel): Promise<boolean> {
  const reservation = await readVideoBillingReservation(task, false);
  if (!reservation) throw new BillingError("视频任务缺少冻结流水，不能确认提交扣费", 409);
  // A token-priced video cannot be settled when the asynchronous task is only
  // accepted. Volcengine reports authoritative usage.completion_tokens on the
  // terminal task object, so the upper-bound reservation remains open.
  if (reservation.unit === "token") {
    return reservation.remainingMicros === 0 && ["charged", "free"].includes(reservation.usageStatus);
  }
  if (reservation.remainingMicros === 0) {
    if (reservation.usageStatus !== "charged") {
      throw new BillingError("视频冻结流水已结束但并非已扣费状态，需人工核账", 409);
    }
    const capture = await db("o_billing_ledger")
      .where({ type: "deduct", relatedLedgerId: reservation.id })
      .where({ amountMicros: reservation.amountMicros })
      .first();
    if (!capture) throw new BillingError("视频冻结流水缺少全额扣费凭证，需人工核账", 409);
    await db("o_relay_task").where({ id: task.id }).update({ costMicros: reservation.amountMicros, updateTime: Date.now() });
    return true;
  }
  if (reservation.remainingMicros !== reservation.amountMicros) {
    throw new BillingError("视频冻结流水已被部分处理，需人工核账", 409);
  }
  await settleApiTaskReservation({
    workspaceId: reservation.workspaceId,
    reservationId: reservation.id,
    actualCostMicros: reservation.amountMicros,
    units: reservation.units,
    unit: reservation.unit,
    provider: channel.provider,
    channelId: channel.id,
    requestId: reservation.requestId,
    idempotencyKey: reservation.billingKey,
    description: `video submit captured: ${task.id}`,
    metadata: {
      billingKey: reservation.billingKey,
      priceSnapshot: reservation.metadata.priceSnapshot || null,
      providerTaskId: task.providerTaskId,
      settlementEvidenceComplete: true,
      settlementUnit: reservation.unit,
    },
    mutationFence: relayVideoBillingMutationFence(task),
    trustedBeforeCommit: storedPrivateValidationBudget(task)
      ? async (transaction, settlement) => {
          const binding = storedPrivateValidationBudget(task);
          if (!binding) throw new BillingError("私有验证预算 binding 在结算边界消失", 409);
          await settleReleaseFullMaintenancePrivateValidationBudgetSlotInTransaction(
            transaction,
            { binding, taskId: task.id, settlement },
          );
        }
      : undefined,
  });
  await db("o_relay_task").where({ id: task.id }).update({ costMicros: reservation.amountMicros, updateTime: Date.now() });
  return true;
}

type VideoTerminalTokenUsage =
  | { ok: true; completionTokens: number; totalTokens: number | null }
  | { ok: false; reason: "missing" | "invalid"; completionTokenType: string; totalTokenType: string };

/**
 * Volcengine's official ContentGenerationTask contract defines the billable
 * video usage at top-level usage.completion_tokens. total_tokens is optional
 * and is retained only as evidence; it is not substituted for a missing
 * completion count.
 */
function readAuthoritativeVideoTokenUsage(payload: Record<string, unknown>): VideoTerminalTokenUsage {
  const usage = payload.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return {
      ok: false,
      reason: "missing",
      completionTokenType: "missing",
      totalTokenType: "missing",
    };
  }
  const record = usage as Record<string, unknown>;
  const completionTokens = record.completion_tokens;
  const totalTokens = record.total_tokens;
  const validCompletion = typeof completionTokens === "number" &&
    Number.isSafeInteger(completionTokens) && completionTokens >= 0;
  const validTotal = totalTokens === undefined || totalTokens === null || (
    typeof totalTokens === "number" &&
    Number.isSafeInteger(totalTokens) &&
    totalTokens >= 0 &&
    validCompletion &&
    totalTokens >= completionTokens
  );
  if (!validCompletion || !validTotal) {
    return {
      ok: false,
      reason: "invalid",
      completionTokenType: completionTokens === undefined ? "missing" : typeof completionTokens,
      totalTokenType: totalTokens === undefined ? "missing" : typeof totalTokens,
    };
  }
  return {
    ok: true,
    completionTokens,
    totalTokens: typeof totalTokens === "number" ? totalTokens : null,
  };
}

function calculateVideoTokenSnapshotCost(reservation: VideoBillingReservation, completionTokens: number): number {
  const snapshot = reservation.metadata.priceSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new BillingError("视频 token 冻结流水缺少价格快照", 409);
  }
  const priceSnapshot = snapshot as Record<string, unknown>;
  const unitPriceMicros = Number(priceSnapshot.unitPriceMicros);
  const multiplier = Number(priceSnapshot.multiplier ?? 1);
  const minimumMicros = Number(priceSnapshot.minimumMicros ?? 0);
  if (!Number.isSafeInteger(unitPriceMicros) || unitPriceMicros <= 0) {
    throw new BillingError("视频 token 价格快照单价无效", 409);
  }
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new BillingError("视频 token 价格快照倍率无效", 409);
  }
  if (!Number.isSafeInteger(minimumMicros) || minimumMicros < 0) {
    throw new BillingError("视频 token 价格快照最低费用无效", 409);
  }
  const baseCostMicros = unitPriceMicros * completionTokens;
  const adjustedCostMicros = Math.round(baseCostMicros * multiplier);
  if (!Number.isSafeInteger(baseCostMicros) || !Number.isSafeInteger(adjustedCostMicros) || adjustedCostMicros < 0) {
    throw new BillingError("视频 token 实际费用超出安全整数范围", 409);
  }
  return Math.max(adjustedCostMicros, minimumMicros);
}

function calculateDeliveredVideoSettlementCost(
  reservation: VideoBillingReservation,
  generationCostMicros: number,
): number {
  const priceSnapshot = reservation.metadata.priceSnapshot;
  const valueVideoSnapshot = priceSnapshot
    && typeof priceSnapshot === "object"
    && !Array.isArray(priceSnapshot)
    ? (priceSnapshot as Record<string, unknown>).fanjinValueVideoPricing
    : null;
  if (valueVideoSnapshot == null) return applyGuChargeRounding(generationCostMicros, reservation.metadata);
  try {
    return applyGuChargeRounding(calculateFanjinValueVideoActualCost({
      snapshot: valueVideoSnapshot,
      actualGenerationCostMicros: generationCostMicros,
    }), reservation.metadata);
  } catch (caught) {
    throw new BillingError(
      `繁境特价版终态组合价格无效: ${caught instanceof Error ? caught.message : "unknown"}`,
      409,
    );
  }
}

async function settleVideoTerminalBilling(
  task: RelayTask,
  channel: RelayChannel,
  payload: Record<string, unknown>,
  terminalStatus: RelayTaskStatus,
  providerResponseOk: boolean,
): Promise<boolean> {
  const reservation = await readVideoBillingReservation(task, false);
  if (!reservation) throw new BillingError("视频任务缺少冻结流水，无法进行终态结算", 409);
  if (channel.provider === "minimax") {
    return await settleMiniMaxH3TerminalBilling({
      task,
      channel,
      payload,
      terminalStatus,
      providerResponseOk,
      reservation,
    });
  }
  if (reservation.unit !== "token") return await settleVideoSubmissionBilling(task, channel);
  if (!["succeeded", "failed", "cancelled"].includes(terminalStatus)) {
    throw new BillingError("视频 token 只能使用供应商终态响应结算", 409);
  }
  if (reservation.remainingMicros === 0 && ["charged", "free"].includes(reservation.usageStatus)) {
    return true;
  }

  const responseTaskId = typeof payload.id === "string" ? payload.id.trim() : "";
  const responseStatus = normalizeKnownProviderStatus(payload.status);
  if (
    !providerResponseOk ||
    channel.provider !== "volcano" ||
    !task.providerTaskId ||
    responseTaskId !== task.providerTaskId ||
    responseStatus !== terminalStatus
  ) {
    await markVideoBillingPending(task, channel, "video_terminal_response_untrusted", {
      providerTaskId: task.providerTaskId,
      providerTerminalStatus: terminalStatus,
      providerResponseOk,
      responseTaskIdMatches: Boolean(task.providerTaskId && responseTaskId === task.providerTaskId),
      responseStatusMatches: responseStatus === terminalStatus,
      authoritativeUsagePath: "usage.completion_tokens",
    });
    return false;
  }

  const usage = readAuthoritativeVideoTokenUsage(payload);
  if (!usage.ok) {
    await markVideoBillingPending(
      task,
      channel,
      usage.reason === "missing" ? "video_terminal_usage_missing" : "video_terminal_usage_invalid",
      {
        providerTaskId: task.providerTaskId,
        providerTerminalStatus: terminalStatus,
        authoritativeUsagePath: "usage.completion_tokens",
        completionTokenType: usage.completionTokenType,
        totalTokenType: usage.totalTokenType,
      },
    );
    return false;
  }

  if (usage.completionTokens > reservation.units) {
    await markVideoBillingPending(task, channel, "video_terminal_usage_exceeds_reservation", {
      providerTaskId: task.providerTaskId,
      providerTerminalStatus: terminalStatus,
      authoritativeUsagePath: "usage.completion_tokens",
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      reservationUpperBoundTokens: reservation.units,
    });
    return false;
  }

  const generationCostMicros = calculateVideoTokenSnapshotCost(
    reservation,
    usage.completionTokens,
  );
  const actualCostMicros = calculateDeliveredVideoSettlementCost(
    reservation,
    generationCostMicros,
  );
  if (actualCostMicros > reservation.amountMicros) {
    await markVideoBillingPending(task, channel, "video_terminal_cost_exceeds_reservation", {
      providerTaskId: task.providerTaskId,
      providerTerminalStatus: terminalStatus,
      completionTokens: usage.completionTokens,
      actualCostMicros,
      reservedCostMicros: reservation.amountMicros,
    });
    return false;
  }

  await settleApiTaskReservation({
    workspaceId: reservation.workspaceId,
    reservationId: reservation.id,
    actualCostMicros,
    units: usage.completionTokens,
    unit: "token",
    provider: channel.provider,
    channelId: channel.id,
    requestId: reservation.requestId,
    idempotencyKey: reservation.billingKey,
    description: `video terminal token usage captured: ${task.id}`,
    metadata: {
      billingKey: reservation.billingKey,
      priceSnapshot: reservation.metadata.priceSnapshot || null,
      providerTaskId: task.providerTaskId,
      providerTerminalStatus: terminalStatus,
      authoritativeUsagePath: "usage.completion_tokens",
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      settlementEvidenceComplete: true,
      settlementUnit: "token",
    },
    mutationFence: relayVideoBillingMutationFence(task),
    trustedBeforeCommit: storedPrivateValidationBudget(task)
      ? async (transaction, settlement) => {
          const binding = storedPrivateValidationBudget(task);
          if (!binding) throw new BillingError("私有验证预算 binding 在终态结算边界消失", 409);
          await settleReleaseFullMaintenancePrivateValidationBudgetSlotInTransaction(
            transaction,
            { binding, taskId: task.id, settlement },
          );
        }
      : undefined,
  });
  await db("o_relay_task").where({ id: task.id }).update({ costMicros: actualCostMicros, updateTime: Date.now() });
  return true;
}

function relayFinalizationFromPayload(resultPayload: Record<string, unknown>): string {
  return String(parseJsonObject(resultPayload.internal).finalization || "").trim();
}

function relayVideoBillingRequestHash(
  task: RelayTask,
  reservation: VideoBillingReservation,
): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    version: "relay-video-billing/v1",
    taskId: task.id,
    workspaceId: task.workspaceId,
    requestId: reservation.requestId,
    reservationId: reservation.id,
    billingKey: reservation.billingKey,
    provider: reservation.provider,
    channelId: reservation.channelId,
    reservedUnits: reservation.units,
    unit: reservation.unit,
    reservedCostMicros: reservation.amountMicros,
    priceSnapshot: reservation.metadata.priceSnapshot || null,
  })).digest("hex");
}

async function settleVideoBillingAfterDelivery(input: {
  task: RelayTask;
  channel: RelayChannel;
  providerPayload: Record<string, unknown>;
  providerTerminalStatus: RelayTaskStatus;
  providerResponseOk: boolean;
  deliveryStatus: RelayTaskStatus;
  resultPayload: Record<string, unknown>;
}): Promise<boolean | "released" | null> {
  if (input.providerTerminalStatus !== "succeeded") {
    if (isDefinitiveVideoTerminalRejection({ provider: input.channel.provider, providerTaskId: input.task.providerTaskId,
      responseOk: input.providerResponseOk, response: input.providerPayload })) {
      await releaseVideoBilling(input.task, "供应商已确认视频生成失败且未计费，自动释放预占", "definitive_not_billable");
      return "released";
    }
    await markVideoBillingPending(
      input.task,
      input.channel,
      "provider_terminal_without_qualified_delivery",
      {
        providerTaskId: input.task.providerTaskId,
        providerTerminalStatus: input.providerTerminalStatus,
        providerResponseOk: input.providerResponseOk,
        customerBillingPolicy: "target_sku_all_or_nothing",
      },
    );
    return false;
  }
  if (isArkVideoTask(input.task)) {
    assertArkVideoCheckpoint(input.task);
    if (!hasArkVideoResult(input.providerPayload)) return false;
    return await settleVideoTerminalBilling(input.task, input.channel, input.providerPayload,
      input.providerTerminalStatus, input.providerResponseOk);
  }
  if (input.deliveryStatus === "enhancing") return null;

  const internal = parseJsonObject(input.resultPayload.internal);
  const finalization = relayFinalizationFromPayload(input.resultPayload);
  if (finalization === "enhancement_failed_fallback") {
    await markVideoBillingPending(
      input.task,
      input.channel,
      "degraded_source_only_requires_reconciliation",
      {
        providerTaskId: input.task.providerTaskId,
        providerTerminalStatus: input.providerTerminalStatus,
        deliveryFinalization: finalization,
        requestedResolution: internal.requestedResolution ?? null,
        deliveredResolution: internal.deliveredResolution ?? internal.generationResolution ?? null,
      },
    );
    return false;
  }

  const finalAssets = input.deliveryStatus === "succeeded"
    ? await db("o_media_asset")
        .where({
          taskId: input.task.id,
          workspaceId: input.task.workspaceId,
          projectId: input.task.projectId,
          source: "relay_final",
        })
        .orderBy("createTime", "asc")
    : [];
  const verifiedDelivery = publishRelayVideoDelivery(
    {
      ...input.task,
      status: input.deliveryStatus,
      providerPayload: { ...input.task.providerPayload, response: input.providerPayload },
      resultPayload: input.resultPayload,
    },
    finalAssets,
  ).projection;
  if (
    input.deliveryStatus !== "succeeded"
    || !readRelayFinalEvidenceDescriptor(internal.deliveryFinalEvidence)
    || verifiedDelivery?.taskStatus !== "succeeded"
    || verifiedDelivery.metRequestedQuality !== true
  ) {
    await markVideoBillingPending(
      input.task,
      input.channel,
      "video_delivery_unverified_after_provider_success",
      {
        providerTaskId: input.task.providerTaskId,
        providerTerminalStatus: input.providerTerminalStatus,
        deliveryStatus: input.deliveryStatus,
        deliveryFinalization: finalization || null,
        deliveryFailureCode: verifiedDelivery?.failure?.code ?? null,
        mediaProbeVerified: Boolean(
          verifiedDelivery?.taskStatus === "succeeded"
          && verifiedDelivery.metRequestedQuality === true,
        ),
      },
    );
    return false;
  }

  try {
    return await settleVideoTerminalBilling(
      input.task,
      input.channel,
      input.providerPayload,
      input.providerTerminalStatus,
      input.providerResponseOk,
    );
  } catch (error: any) {
    const reservation = await readVideoBillingReservation(input.task, false);
    if (!reservation) throw error;
    let actualUnits = reservation.units;
    let actualCostMicros = reservation.amountMicros;
    if (reservation.unit === "token") {
      const usage = readAuthoritativeVideoTokenUsage(input.providerPayload);
      if (!usage.ok) throw error;
      actualUnits = usage.completionTokens;
      actualCostMicros = calculateDeliveredVideoSettlementCost(
        reservation,
        calculateVideoTokenSnapshotCost(reservation, usage.completionTokens),
      );
    }
    const finalAsset = finalAssets.length === 1 ? finalAssets[0] : null;
    const finalAssetMetadata = parseJsonObject(finalAsset?.metadata);
    await markVideoBillingPending(
      input.task,
      input.channel,
      "video_terminal_settlement_failed",
      {
        settlementEvidenceComplete: true,
        requestHash: relayVideoBillingRequestHash(input.task, reservation),
        providerTaskId: input.task.providerTaskId,
        providerTerminalStatus: input.providerTerminalStatus,
        providerResponseOk: input.providerResponseOk,
        deliveryStatus: input.deliveryStatus,
        deliveryFinalization: finalization,
        resultAssetId: finalAsset?.id ?? null,
        resultUrl: finalAsset?.url ?? null,
        deliveryFinalEvidence: finalAssetMetadata.deliveryFinalEvidence ?? null,
        mediaProbe: finalAssetMetadata.mediaProbe ?? null,
        settlementUnit: reservation.unit,
      },
      {
        units: actualUnits,
        unit: reservation.unit,
        actualCostMicros,
      },
    );
    return false;
  }
}

async function releaseVideoBilling(
  task: RelayTask,
  reason: string,
  releaseProof: "not_dispatched" | "definitive_not_billable" = "not_dispatched",
): Promise<void> {
  const reservation = await readVideoBillingReservation(task, false);
  if (!reservation) throw new BillingError("视频任务缺少冻结流水，无法释放预扣", 500);
  if (reservation.remainingMicros === 0) {
    if (reservation.usageStatus === "released") return;
    throw new BillingError("视频冻结流水已结束且并非释放状态", 409);
  }
  await releaseApiTaskReservation({
    workspaceId: reservation.workspaceId,
    reservationId: reservation.id,
    requestId: reservation.requestId,
    idempotencyKey: reservation.billingKey,
    provider: reservation.provider,
    channelId: reservation.channelId,
    description: reason,
    metadata: { taskId: task.id, reason },
    releaseProof,
    mutationFence: relayVideoBillingMutationFence(task),
    trustedBeforeCommit: storedPrivateValidationBudget(task)
      ? async (transaction) => {
          const binding = storedPrivateValidationBudget(task);
          if (!binding) throw new BillingError("私有验证预算 binding 在释放边界消失", 409);
          await releaseReleaseFullMaintenancePrivateValidationBudgetSlotInTransaction(
            transaction,
            {
              binding,
              taskId: task.id,
              reservationId: reservation.id,
              releaseProof,
            },
          );
        }
      : undefined,
  });
}

/** 路径 A 单任务最多尝试的配方条数(env 可调,默认 3),防止候选池异常时无限重试。 */
function videoRecipeFailoverMaxAttempts(): number {
  const configured = Number(process.env.FANJIN_VIDEO_RECIPE_FAILOVER_MAX_ATTEMPTS || 3);
  if (!Number.isFinite(configured) || configured < 1) return 3;
  return Math.floor(configured);
}

/**
 * 路径 A 配方 failover(design §5.1):一次生成/提交失败后,按
 * 「priority 升序、同 priority 内加权」的候选池切到下一条候选配方重试;
 * 候选耗尽(或达到 maxAttempts)时返回 null,由调用方走既有终态流程。
 *
 * 计费安全边界(不重复扣费):
 * - 仅当当前冻结仍然打开且当前 attempt 能证明从未 dispatch 时才允许切换;
 * - 切换复用同一个产品 reservation、quote 和价格快照，不 release/re-reserve；
 * - 一旦存在 dispatch marker，普通 worker 禁止 failover，由 reconciler 关闭 attempt。
 * - API Key 请求配额在切换时不动(创建时预占一次,终态时一次性结算)。
 *
 * 留痕:被放弃的尝试追加到 resultPayload.internal.attempts
 * ([{recipeId, channelId, outcome, message, at}]);当前配方始终是 internal.recipeId。
 */
async function tryVideoRecipeFailover(task: RelayTask, input: {
  outcome: string;
  message: string;
}): Promise<RelayTask | null> {
  if (task.endpointType !== "video_generation" || !task.workspaceId || isArkVideoTask(task)) return null;
  const current = (await getRelayTask(task.id)) || task;
  if (isTerminalStatus(current.status)) return null;
  // A private-validation slot is bound to one exact provider/channel/pricing
  // identity. Even pre-dispatch recipe failover would make that durable
  // binding stale; after dispatch it could also obscure the one-POST ceiling.
  // Let the normal failure path release or reconcile the sole reservation.
  if (storedPrivateValidationBudget(current) || persistedVideoAssetPolicyCheckpoint(current).canonicalRequest?.renderMode === "finalize") return null;
  const workspaceId = String(current.workspaceId || "").trim();
  if (!workspaceId) return null;
  const plan = restoreVideoResolutionPlanFromInternal(current.resultPayload, current.requestPayload);
  if (!plan.recipeId || plan.invalidResolution) return null;
  const publicModel = String(current.requestPayload?.model || "").trim();
  const targetResolution = plan.finalResolution || plan.requestedResolution;
  if (!publicModel || !targetResolution || !isPublicVideoResolution(targetResolution)) return null;

  // 冻结已结束(已扣费/已释放)的尝试不能重试,这是不重复扣费的硬边界。
  let reservation: VideoBillingReservation | null = null;
  try {
    reservation = await readVideoBillingReservation(current, false);
  } catch {
    return null;
  }
  if (!reservation || reservation.remainingMicros <= 0) return null;
  // A dispatch marker means the current attempt may already be billable.
  // A broad provider "failed" status, timeout, 429, or other transport outcome
  // cannot close that attempt or authorize another one. Keep the sole product
  // reservation frozen and let reconciliation determine provider billability.
  if (hasVideoDispatchEvidence(current)) return null;

  const maxAttempts = videoRecipeFailoverMaxAttempts();
  const attempts: VideoRecipeAttempt[] = [...(plan.attempts || [])];
  const appendAttempt = (recipeId: string | null, channelId: string | null, outcome: string, message: string) => {
    attempts.push({
      recipeId,
      channelId,
      outcome,
      message: redactRelayText(message).slice(0, 500),
      at: Date.now(),
    });
  };
  appendAttempt(plan.recipeId, current.channelId, input.outcome, input.message);
  if (attempts.length >= maxAttempts) return null;

  const triedRecipeIds = new Set(
    attempts.map((attempt) => attempt.recipeId).filter((id): id is string => Boolean(id)),
  );
  let candidates: VideoFulfillmentRecipe[] = [];
  try {
    candidates = await listFailoverCandidateRecipes(db as any, {
      publicModel,
      targetResolution,
      excludeRecipeIds: [...triedRecipeIds],
    });
  } catch {
    candidates = [];
  }

  let nextRecipe: VideoFulfillmentRecipe | null = null;
  let nextChannel: RelayChannel | null = null;
  for (const candidate of candidates) {
    if (attempts.length >= maxAttempts) break;
    if (
      (isHighPublicVideoResolution(targetResolution) || isFanjinValueVideoModel(publicModel))
      && !await isVideoFulfillmentRecipeReady({
        database: db as any,
        workspaceId,
        publicModel,
        targetResolution,
        recipe: candidate,
      })
    ) {
      appendAttempt(
        candidate.id,
        candidate.generateChannelId,
        "fulfillment_unavailable",
        "候选配方缺少健康生成/超分通道或可执行价格",
      );
      continue;
    }
    const channel = await selectChannelById(candidate.generateChannelId, {
      endpointType: current.endpointType,
      workspaceId: current.workspaceId,
      provider: null,
    });
    if (!channel) {
      appendAttempt(candidate.id, candidate.generateChannelId, "channel_unavailable", "候选配方的生成通道不可用");
      continue;
    }
    // The existing reservation is priced for one provider. A pre-dispatch
    // channel failover may rebind that provider's operational channel, but it
    // must not silently reuse the quote for a different provider.
    if (String(channel.provider || "") !== reservation.provider) {
      appendAttempt(
        candidate.id,
        candidate.generateChannelId,
        "billing_provider_mismatch",
        "候选配方供应商与当前价格快照不一致",
      );
      continue;
    }
    nextRecipe = candidate;
    nextChannel = channel;
    break;
  }
  if (!nextRecipe || !nextChannel) return null;

  const attemptNo = attempts.length + 1;
  const nextPlan: VideoResolutionPlan = {
    requestedResolution: plan.requestedResolution,
    generationResolution: nextRecipe.generateResolution,
    finalResolution: nextRecipe.targetResolution,
    needsEnhancement: nextRecipe.enhanceEnabled,
    recipeId: nextRecipe.id,
    enhanceChannelId: nextRecipe.enhanceEnabled ? nextRecipe.enhanceChannelId : null,
    upstreamModel: nextRecipe.upstreamModel,
    attempts,
  };
  const nextDispatchInput: CreateRelayTaskInput = {
    endpointType: current.endpointType,
    apiKeyId: current.apiKeyId,
    workspaceId: current.workspaceId,
    projectId: current.projectId,
    requestId: current.requestId,
    model: publicModel,
    provider: nextChannel.provider,
    requestPayload: current.requestPayload,
  };

  // 换配方只改 dispatch 计划:通道/上游 model/分辨率计划/submission 状态全部重置,
  // 任务回到 queued 由 worker 重新提交;身份、产品 reservation、quote 和 API 配额不变。
  const requeuedAt = Date.now();
  if (
    !current.leaseOwner
    || !Number.isSafeInteger(current.leaseExpiresAt)
    || Number(current.leaseExpiresAt) <= requeuedAt
  ) {
    return null;
  }
  const requeued = await db.transaction(async (trx) => {
    let taskQuery = trx("o_relay_task")
      .where({
        id: current.id,
        workspaceId: current.workspaceId,
        provider: current.provider,
        channelId: current.channelId,
        leaseOwner: current.leaseOwner,
        leaseExpiresAt: current.leaseExpiresAt,
      })
      .whereIn("status", ["queued", "running"])
      .where("leaseExpiresAt", ">", requeuedAt);
    if (isPostgresClient(trx)) taskQuery = taskQuery.forUpdate();
    const lockedTaskRow = await taskQuery.first();
    if (!lockedTaskRow) return "fence_lost" as const;
    const lockedTask = parseRelayTask(lockedTaskRow);
    if (
      lockedTask.providerTaskId
      || lockedTask.submittedAt
      || hasVideoDispatchEvidence(lockedTask)
    ) {
      return "dispatch_observed" as const;
    }

    let ledgerQuery = trx("o_billing_ledger").where({
      id: reservation.id,
      workspaceId: reservation.workspaceId,
      type: "freeze",
      relatedTaskId: current.id,
      relatedUsageId: reservation.usageRecordId,
    });
    if (isPostgresClient(trx)) ledgerQuery = ledgerQuery.forUpdate();
    const ledger = await ledgerQuery.first();
    if (!ledger) return "billing_invalid" as const;
    const ledgerMetadata = parseJsonObject(ledger.metadata);
    const priceSnapshot = ledgerMetadata.priceSnapshot
      && typeof ledgerMetadata.priceSnapshot === "object"
      && !Array.isArray(ledgerMetadata.priceSnapshot)
      ? ledgerMetadata.priceSnapshot as Record<string, unknown>
      : {};
    const lifecycleState = String(ledgerMetadata.billingLifecycleState || "");
    if (
      lifecycleState === "dispatch_started"
      || lifecycleState === "pending_reconcile"
    ) {
      return "dispatch_observed" as const;
    }
    if (
      Number(ledger.remainingMicros || 0) !== Number(ledger.amountMicros || 0)
      || Number(ledger.remainingMicros || 0) <= 0
      || lifecycleState !== "reserved"
      || String(priceSnapshot.provider || "") !== reservation.provider
      || String(priceSnapshot.provider || "") !== String(nextChannel.provider || "")
    ) {
      return "billing_invalid" as const;
    }
    const reconcileJob = await trx("o_billing_reconcile_job")
      .where({ reservationId: reservation.id })
      .first();
    if (reconcileJob) return "dispatch_observed" as const;

    let usageQuery = trx("o_usage_record").where({
      id: reservation.usageRecordId,
      workspaceId: reservation.workspaceId,
      taskId: current.id,
      endpointType: "video_generation",
      provider: reservation.provider,
      channelId: reservation.channelId,
      status: "reserved",
    });
    if (isPostgresClient(trx)) usageQuery = usageQuery.forUpdate();
    const usage = await usageQuery.first();
    if (!usage) return "billing_invalid" as const;

    const taskAffected = await trx("o_relay_task")
      .where({
        id: current.id,
        workspaceId: current.workspaceId,
        provider: current.provider,
        channelId: current.channelId,
        leaseOwner: current.leaseOwner,
        leaseExpiresAt: current.leaseExpiresAt,
      })
      .whereIn("status", ["queued", "running"])
      .whereNull("providerTaskId")
      .whereNull("submittedAt")
      .where("leaseExpiresAt", ">", requeuedAt)
      .update({
        provider: nextChannel.provider,
        channelId: nextChannel.id,
        model: publicModel,
        status: "queued",
        providerTaskId: null,
        providerPayload: stringifyJson({
          identity: (current.providerPayload as Record<string, unknown>)?.identity || {},
          request: buildProviderRequestPayload(nextDispatchInput, nextPlan, {
            canonicalRequest: persistedVideoAssetPolicyCheckpoint(current).canonicalRequest,
          }),
          billing: (current.providerPayload as Record<string, unknown>)?.billing || {},
          submission: {
            state: "recipe_failover_requeued",
            attempt: attemptNo,
            maxAttempts,
            previousRecipeId: plan.recipeId,
            requeuedAt,
            retryAllowed: true,
          },
        }),
        resultPayload: stringifyJson({
          internal: buildVideoInternalPlan(nextPlan, current.resultPayload.internal),
        }),
        errorMessage: null,
        submittedAt: null,
        completedAt: null,
        updateTime: requeuedAt,
        ...releaseLeasePatch(),
      });
    if (Number(taskAffected || 0) !== 1) {
      throw new BillingError("视频 failover 任务 fence 已变化", 409);
    }
    const usageAffected = await trx("o_usage_record")
      .where({
        id: reservation.usageRecordId,
        provider: reservation.provider,
        channelId: reservation.channelId,
        status: "reserved",
      })
      .update({
        provider: nextChannel.provider,
        channelId: nextChannel.id,
      });
    if (Number(usageAffected || 0) !== 1) {
      throw new BillingError("视频 failover 用量通道重绑定失败", 409);
    }
    const failoverHistory = Array.isArray(ledgerMetadata.channelFailoverHistory)
      ? ledgerMetadata.channelFailoverHistory.slice(-15)
      : [];
    const ledgerAffected = await trx("o_billing_ledger")
      .where({
        id: reservation.id,
        workspaceId: reservation.workspaceId,
        updatedAt: ledger.updatedAt,
      })
      .where("remainingMicros", ">", 0)
      .update({
        metadata: stringifyJson({
          ...ledgerMetadata,
          provider: nextChannel.provider,
          channelId: nextChannel.id,
          channelFailoverHistory: [
            ...failoverHistory,
            {
              fromChannelId: reservation.channelId,
              toChannelId: nextChannel.id,
              fromRecipeId: plan.recipeId,
              toRecipeId: nextRecipe.id,
              at: requeuedAt,
            },
          ],
        }),
        updatedAt: Math.max(requeuedAt, Number(ledger.updatedAt || 0) + 1),
      });
    if (Number(ledgerAffected || 0) !== 1) {
      throw new BillingError("视频 failover 冻结流水重绑定失败", 409);
    }
    return "requeued" as const;
  });
  if (requeued === "billing_invalid") return null;
  // A lost task fence or newly observed dispatch boundary belongs to another
  // worker/reconciler. Return the latest row so this stale caller cannot turn
  // it into a contradictory terminal failure.
  return await getRelayTask(current.id);
}

export async function selectChannel(input: CreateRelayTaskInput): Promise<RelayChannel | null> {
  input = { ...input, model: internalModelId(input.model) };
  const routeQuery = db("o_model_route")
    .where({ endpointType: input.endpointType })
    .orderBy("priority", "asc")
    .orderBy("fallbackOrder", "asc")
    .orderBy("createTime", "asc")
    .orderBy("id", "asc");

  if (input.model) routeQuery.andWhere("model", input.model);
  applyScopeFilter(routeQuery, input.workspaceId);

  const preferredScopeRoutes = selectPreferredModelRouteScope(await routeQuery, input.workspaceId);
  const routes = preferredScopeRoutes.filter((route) => {
    if (route.disabled === true || Number(route.disabled) === 1) return false;
    return !input.provider || String(route.provider || "").trim() === String(input.provider);
  });

  // Scope selection precedes provider filtering. This makes an explicit
  // workspace override authoritative even when disabled or configured for a
  // different provider, so it can never fall through to platform/generic
  // routing.
  if (preferredScopeRoutes.length > 0 && routes.length === 0) return null;

  const selectProviderChannel = async (route?: Record<string, any>): Promise<RelayChannel | null> => {
    const channelQuery = db("o_provider_channel").where({ endpointType: input.endpointType, disabled: 0 });
    const providerFilter = route?.provider || input.provider;
    if (providerFilter) channelQuery.andWhere("provider", providerFilter);
    applyScopeFilter(channelQuery, input.workspaceId);

    const candidates = await channelQuery
      .orderByRaw(
        "CASE WHEN ?? = 'ok' THEN 0 WHEN ?? IS NULL THEN 1 WHEN ?? = 'degraded' THEN 2 ELSE 3 END",
        ["healthStatus", "healthStatus", "healthStatus"],
      )
      .orderBy("priority", "asc")
      .orderBy("weight", "desc")
      .limit(20);
    const hasNonFailedCandidate = candidates.some((channel: any) => channel.healthStatus !== "failed");
    for (const channel of candidates) {
      if (!channelSupportsRequestedModel(channel, input.model, route ? [route] : [])) continue;
      if (hasNonFailedCandidate && channel.healthStatus === "failed") continue;
      if (!(await channelHasCapacity(channel))) continue;
      const parsed = parseRelayChannel(channel);
      parsed.routeConfig = parseVideoRouteConfig(route?.routeConfig);
      return parsed;
    }
    return null;
  };

  if (routes.length === 0) return await selectProviderChannel();

  for (const route of routes) {
    // channelId 是严格策略绑定。单条绑定失效时只能尝试同一首选 scope
    // 中显式配置的下一条 fallback route，不能退回平台或通用 channel。
    if (route.channelId) {
      const boundQuery = db("o_provider_channel")
        .where({ endpointType: input.endpointType, disabled: 0, id: route.channelId });
      applyScopeFilter(boundQuery, input.workspaceId);
      const expectedProvider = String(route.provider || input.provider || "").trim();
      if (expectedProvider) boundQuery.andWhere("provider", expectedProvider);
      const bound = await boundQuery.first();
      if (!bound || !relayRouteBindingMatchesChannel(route, bound, input)) continue;
      if (!(await channelHasCapacity(bound))) continue;
      const parsed = parseRelayChannel(bound);
      parsed.routeConfig = parseVideoRouteConfig(route.routeConfig);
      return parsed;
    }

    // Provider-scoped routing is the only valid unbound mode. A malformed
    // provider-neutral row cannot authorize every provider, but a later
    // explicit fallback route in the same scope may still be used.
    if (!String(route.provider || "").trim()) continue;
    const selected = await selectProviderChannel(route);
    if (selected) return selected;
  }
  return null;
}

export async function storeMediaAsset(input: StoreMediaAssetInput): Promise<string | null> {
  if (!input.url && !input.localPath) return null;
  if (
    ["relay_final", "video_enhance"].includes(
      String(input.source || ""),
    )
    && (
      !Number.isSafeInteger(Number(input.projectId))
      || Number(input.projectId) <= 0
      || !String(input.workspaceId || "").trim()
    )
  ) {
    throw relayFinalAssetError(
      "media_asset_project_ownership_required",
      "project-bound media asset requires projectId and workspaceId",
    );
  }

  const id = uuid();
  await db("o_media_asset").insert({
    id,
    taskId: input.taskId,
    workspaceId: input.workspaceId ?? null,
    projectId: input.projectId ?? null,
    assetType: input.assetType,
    source: input.source ?? "relay",
    url: input.url ?? null,
    localPath: input.localPath ?? null,
    mimeType: input.mimeType ?? null,
    width: input.width ?? null,
    height: input.height ?? null,
    durationMs: input.durationMs ?? null,
    metadata: stringifyJson(input.metadata),
    createTime: Date.now(),
  });

  return id;
}

async function insertRelayTaskWithProjectAuthority(
  input: CreateRelayTaskInput,
  row: Record<string, unknown>,
  videoPlan?: VideoResolutionPlan | null,
): Promise<void> {
  if (input.projectId == null) {
    await db.transaction(async (trx) => {
      if (videoPlan?.enhanceChannelId) await lockMediaServiceForTask(trx, videoPlan.enhanceChannelId, String(videoPlan.finalResolution));
      await trx("o_relay_task").insert(row);
    });
    return;
  }

  const projectId = Number(input.projectId);
  const workspaceId = String(input.workspaceId || "").trim();
  if (!workspaceId) {
    throw relayTaskProjectAuthorityError(
      "relay_task_workspace_required",
      "project-bound relay task requires workspaceId",
      400,
    );
  }

  await db.transaction(async (trx) => {
    if (videoPlan?.enhanceChannelId) await lockMediaServiceForTask(trx, videoPlan.enhanceChannelId, String(videoPlan.finalResolution));
    const project = await trx("o_project")
      .where({ id: projectId, workspaceId })
      .select("id", "workspaceId", "deletionState")
      .forUpdate()
      .first();
    if (!project) {
      throw relayTaskProjectAuthorityError(
        "relay_task_project_not_found",
        "relay task project does not exist",
        404,
      );
    }
    if (String(project.deletionState || "") !== "active") {
      throw relayTaskProjectAuthorityError(
        "relay_task_project_not_active",
        "relay task project is not active",
        409,
      );
    }
    await trx("o_relay_task").insert(row);
  });
}

export async function assertRelayTaskProjectAuthority(
  input: Pick<CreateRelayTaskInput, "endpointType" | "workspaceId" | "projectId">,
): Promise<void> {
  if (input.projectId == null) return;
  const projectId = Number(input.projectId);
  const workspaceId = String(input.workspaceId || "").trim();
  if (!workspaceId) {
    throw relayTaskProjectAuthorityError(
      "relay_task_workspace_required",
      "project-bound relay task requires workspaceId",
      400,
    );
  }
  const project = await db("o_project")
    .where({ id: projectId, workspaceId })
    .select("id", "workspaceId", "deletionState")
    .first();
  if (!project) {
    throw relayTaskProjectAuthorityError(
      "relay_task_project_not_found",
      "relay task project does not exist",
      404,
    );
  }
  if (String(project.deletionState || "") !== "active") {
    throw relayTaskProjectAuthorityError(
      "relay_task_project_not_active",
      "relay task project is not active",
      409,
    );
  }
}

async function arkDraftParent(input: Pick<CreateRelayTaskInput, "requestPayload" | "apiKeyId" | "workspaceId" | "model">,
  database: Knex | Knex.Transaction): Promise<RelayTask | null> {
  const parts = Array.isArray(input.requestPayload.content) ? input.requestPayload.content : [];
  const refs = parts.filter((p: any) => p?.type === "draft_task");
  if (!refs.length) return null;
  if (refs.length !== 1 || parts.length !== 1) throw arkProtocolError("draft_task 必须是唯一输入");
  const row = await database("o_relay_task").where({ id: refs[0].draft_task.id,
    apiKeyId: input.apiKeyId, workspaceId: input.workspaceId }).first();
  if (!row) throw arkProtocolError("样片任务不存在或无权访问", 404, "NotFound");
  const parent = parseRelayTask(row);
  const days = parent.createTime >= Date.parse("2026-10-28T10:00:00+08:00") ? 14 : 7;
  if (!isArkVideoTask(parent) || parent.status !== "succeeded" || parent.requestPayload.draft !== true
    || !parent.providerTaskId || parent.model !== input.model || Date.now() - parent.createTime > days * 86400000) {
    throw arkProtocolError("样片未完成、已过期或模型不匹配");
  }
  return parent;
}

async function arkDispatchPayload(task: RelayTask, database: Knex | Knex.Transaction) {
  assertArkVideoCheckpoint(task);
  const payload = arkProviderPayload(task.requestPayload);
  const parent = await arkDraftParent(task, database);
  if (parent) {
    if (parent.channelId !== task.channelId) throw arkProtocolError("样片必须使用原通道", 409);
    payload.content = [{ type: "draft_task", draft_task: { id: parent.providerTaskId } }];
  }
  return payload;
}

async function assertArkReferenceOwnership(
  input: Pick<CreateRelayTaskInput, "requestPayload" | "workspaceId" | "actorUserId"> & { providerPayload?: Record<string, unknown> },
  channel: RelayChannel, database: Knex | Knex.Transaction,
): Promise<void> {
  const parts = Array.isArray(input.requestPayload.content) ? input.requestPayload.content : [];
  const uris = parts.map((p: any) => p?.[p.type]?.url).filter((s: unknown): s is string => typeof s === "string" && s.startsWith("asset://"));
  if (!uris.length) return;
  if (!database.isTransaction) {
    await database.transaction(trx => assertArkReferenceOwnership(input, channel, trx));
    return;
  }
  const actorUserId = Number(input.actorUserId || parseJsonObject(input.providerPayload?.identity).actorUserId);
  const authority = await requireLiveWorkspaceAuthority({ database: database as Knex.Transaction, actorUserId,
    authenticatedWorkspaceId: String(input.workspaceId), workspaceId: String(input.workspaceId), permission: "generation:create" });
  const account = portraitChannelAccountSnapshot(channel);
  for (const uri of new Set(uris)) {
    const asset = await database(`${PORTRAIT_PROVIDER_ASSET_TABLE} as a`)
      .join(`${PORTRAIT_PROVIDER_GROUP_TABLE} as g`, "g.id", "a.groupBindingId")
      .where({ "a.workspaceId": input.workspaceId, "a.channelId": channel.id,
        "a.providerAssetUri": uri, "a.state": "active", "g.state": "active",
        "g.providerAccountFingerprint": account.fingerprint, "g.projectName": account.projectName })
      .select("a.projectId").first();
    if (!asset) throw arkProtocolError("素材 ID 不属于当前可用通道或工作区", 403, "AccessDenied");
    const permission = await checkProjectPermission({ database, projectId: Number(asset.projectId), userId: actorUserId,
      role: authority.actor.role, authWorkspaceId: String(input.workspaceId), permission: "project:read" });
    if (!permission.allowed) throw arkProtocolError("无权使用该素材", 403, "AccessDenied");
  }
}

function seedance25ProbePricingScopeMatches(
  pricingRule: Record<string, any>,
  workspaceId: string,
): boolean {
  const scope = String(pricingRule.scope || "").trim();
  const boundWorkspaceId = String(pricingRule.workspaceId || "").trim();
  if (scope === "platform") return !boundWorkspaceId;
  return scope === "workspace" && boundWorkspaceId === workspaceId;
}

function seedance25ProbeRouteScopeMatches(
  route: Record<string, any>,
  workspaceId: string,
): boolean {
  const scope = String(route.scope || "").trim();
  const boundWorkspaceId = String(route.workspaceId || "").trim();
  if (scope === "platform") return !boundWorkspaceId;
  return scope === "workspace" && boundWorkspaceId === workspaceId;
}

async function resolveSeedance25CertificationProbe(
  probeId: string,
): Promise<ResolvedSeedance25CertificationProbe> {
  if (
    typeof probeId !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(probeId)
  ) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_id_invalid",
      "Seedance 2.5 首次认证探针 ID 无效",
      400,
    );
  }

  const candidateRoutes = await db("o_model_route")
    .where({
      endpointType: "video_generation",
      model: SEEDANCE_25_MODEL_ID,
    });
  const matches = candidateRoutes.filter((row: Record<string, unknown>) => {
    const routeConfig = parseJsonObject(row.routeConfig);
    const permit = parseJsonObject(routeConfig.certificationProbe);
    return permit.probeId === probeId;
  });
  if (matches.length !== 1) {
    throw seedance25CertificationProbeError(
      matches.length === 0
        ? "seedance25_certification_probe_not_found"
        : "seedance25_certification_probe_ambiguous",
      matches.length === 0
        ? "未找到 operator 预写的 Seedance 2.5 首次认证探针 permit"
        : "同一 Seedance 2.5 首次认证探针 ID 绑定了多个路由",
      matches.length === 0 ? 404 : 409,
    );
  }

  const routeRow = matches[0] as Record<string, any>;
  const routeConfig = parseJsonObject(routeRow.routeConfig);
  const permit = assertSeedance25CertificationProbePermit(
    routeConfig.certificationProbe,
  );
  if (
    String(routeRow.id || "") !== permit.routeId
    || Number(routeRow.disabled || 0) !== 0
    || String(routeRow.endpointType || "") !== "video_generation"
    || String(routeRow.model || "") !== SEEDANCE_25_MODEL_ID
    || String(routeRow.provider || "") !== "volcano"
    || String(routeRow.channelId || "") !== permit.channelId
    || !seedance25ProbeRouteScopeMatches(routeRow, permit.workspaceId)
  ) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_route_mismatch",
      "Seedance 2.5 首次认证探针 permit 与启用路由不一致",
    );
  }

  const projectId = Number(permit.projectId);
  const adminUserId = Number(permit.adminUserId);
  const [channelRow, pricingRule, actor, workspace, project] = await Promise.all([
    db("o_provider_channel").where({ id: permit.channelId }).first(),
    db("o_pricing_rule").where({ id: permit.pricingRuleId }).first(),
    db("o_user").where({ id: adminUserId }).first(),
    db("o_workspace").where({ id: permit.workspaceId }).first(),
    db("o_project").where({ id: projectId, workspaceId: permit.workspaceId }).first(),
  ]);
  if (
    !channelRow
    || Number(channelRow.disabled || 0) !== 0
    || String(channelRow.endpointType || "") !== "video_generation"
    || String(channelRow.provider || "") !== "volcano"
    || !relayRouteBindingMatchesChannel(routeRow, channelRow, {
      endpointType: "video_generation",
      provider: "volcano",
      workspaceId: permit.workspaceId,
    })
  ) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_channel_mismatch",
      "Seedance 2.5 首次认证探针 permit 与启用通道不一致",
    );
  }
  if (
    !pricingRule
    || String(pricingRule.id || "") !== permit.pricingRuleId
    || Number(pricingRule.disabled || 0) !== 0
    || String(pricingRule.endpointType || "") !== "video_generation"
    || String(pricingRule.provider || "") !== "volcano"
    || String(pricingRule.model || "") !== SEEDANCE_25_MODEL_ID
    || !seedance25ProbePricingScopeMatches(pricingRule, permit.workspaceId)
  ) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_pricing_mismatch",
      "Seedance 2.5 首次认证探针 permit 与启用定价规则不一致",
    );
  }

  let pricingReadback: Seedance25PricingReadbackBinding;
  try {
    pricingReadback = assertSeedance25PricingRuleReadback({
      provider: pricingRule.provider,
      model: pricingRule.model,
      unit: pricingRule.unit,
      currency: pricingRule.currency,
      baseUnitPriceMicros: pricingRule.unitPriceMicros,
      ruleConfig: pricingRule.ruleConfig,
    });
  } catch {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_pricing_readback_invalid",
      "Seedance 2.5 首次认证探针必须绑定精确的 700/420 GU/百万 Token 双档 token 定价读回",
    );
  }
  try {
    assertSeedance25ArmedSnapshotForRuntime(routeRow, pricingRule, permit);
  } catch (error: any) {
    throw seedance25CertificationProbeError(
      String(error?.code || "seedance25_certification_probe_snapshot_invalid"),
      String(error?.message || "Seedance 2.5 首次认证探针 armed 快照无效"),
    );
  }
  if (
    !actor
    || String(actor.status || "").toLowerCase() !== "active"
    || !["root", "admin", "super_admin"].includes(
      String(actor.role || "").toLowerCase(),
    )
  ) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_admin_inactive",
      "Seedance 2.5 首次认证探针必须绑定 active 平台管理员",
      403,
    );
  }
  if (!workspace || String(workspace.status || "").toLowerCase() !== "active") {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_workspace_inactive",
      "Seedance 2.5 首次认证探针必须绑定 active 工作区",
      409,
    );
  }
  if (!project || String(project.deletionState || "") !== "active") {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_project_inactive",
      "Seedance 2.5 首次认证探针必须绑定 active 项目",
      409,
    );
  }

  return {
    permit,
    pricingReadback,
    routeRow,
    channelRow,
  };
}

function assertSeedance25CertificationProbeContext(
  expected: Seedance25CertificationProbeInternalContext,
  actual: ResolvedSeedance25CertificationProbe,
): void {
  if (
    expected.brand !== SEEDANCE_25_CERTIFICATION_PROBE_BRAND
    || stableStringifyJson(expected.permit) !== stableStringifyJson(actual.permit)
    || stableStringifyJson(expected.pricingReadback)
      !== stableStringifyJson(actual.pricingReadback)
  ) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_context_changed",
      "Seedance 2.5 首次认证探针 permit 或定价读回在派发前发生变化",
    );
  }
}

/**
 * 连接注入边界(REVAMP-PLAN 风险 #7,架构上不可注入 Gateway 事务):
 * 1. selectChannel/channelRouter 的通道槽位租约是跨请求并发信号量,必须
 *    即时独立提交,注入后随 Gateway 回滚消失会造成通道容量超卖;
 * 2. 视频计费预扣(reserveVideoBilling → billApiTask)是独立原子计费事务,
 *    必须独立于调用方事务提交并留存待核账(见 billing.ts billApiTask 注释);
 * 3. 中继任务行由 relay worker 异步接力,生命周期独立于 Agent Run。
 * SQLite 默认 pool max=1:在 Gateway 事务内调用本函数需
 * FANJIN_SQLITE_POOL_MAX≥2(风险清单建议 ≥4)。
 */
async function createRelayTaskInternal(
  input: CreateRelayTaskInput,
  options: CreateRelayTaskOptions = {},
  certificationProbeContext: Seedance25CertificationProbeInternalContext | null = null,
): Promise<{ task: RelayTask; channel: RelayChannel | null }> {
  const arkProtocol = options.trustedArkVideoProtocol === ARK_VIDEO_PROTOCOL;
  input = normalizeRelayTaskInput(input, arkProtocol);
  if (arkProtocol) {
    if (input.endpointType !== "video_generation" || input.provider !== "volcano"
      || !input.apiKeyId || !input.workspaceId || input.projectId !== null
      || options.trustedCanonicalVideoGeneration || options.trustedVideoProviderAdapter
      || options.trustedPrivateValidationBudget || options.trustedVideoAssetPolicyEvidence) {
      throw arkProtocolError("官方协议入口身份不一致", 403, "AccessDenied");
    }
    const { callback_secret_ciphertext: _callback, ...body } = input.requestPayload;
    parseArkVideoRequest(body);
  }
  let privateValidationBudget = validateTrustedPrivateValidationBudget(
    input,
    options.trustedPrivateValidationBudget ?? null,
    certificationProbeContext !== null,
  );
  let privateValidationBudgetPricingCheckpoint:
    PrivateValidationBudgetPricingCheckpoint | null = null;
  let resolvedCertificationProbe: ResolvedSeedance25CertificationProbe | null = null;
  if (certificationProbeContext) {
    if (certificationProbeContext.brand !== SEEDANCE_25_CERTIFICATION_PROBE_BRAND) {
      throw seedance25CertificationProbeError(
        "seedance25_certification_probe_brand_invalid",
        "Seedance 2.5 首次认证探针缺少服务器内部 brand",
      );
    }
    resolvedCertificationProbe = await resolveSeedance25CertificationProbe(
      certificationProbeContext.permit.probeId,
    );
    assertSeedance25CertificationProbeContext(
      certificationProbeContext,
      resolvedCertificationProbe,
    );
  }
  const billingAuthorization = options.trustedVideoBillingAuthorization ?? null;
  const canonicalVideoGeneration = validateTrustedCanonicalVideoGeneration(
    input,
    options.trustedCanonicalVideoGeneration ?? null,
  );
  const videoProviderAdapter = validateTrustedVideoProviderAdapter(
    input,
    options.trustedVideoProviderAdapter ?? null,
    canonicalVideoGeneration,
  );
  const exactSeedance25Requested = input.endpointType === "video_generation"
    && (
      [SEEDANCE_25_MODEL_ID, BYTEPLUS_SEEDANCE_25_MODEL_ID].includes(String(input.model || "").trim() as typeof SEEDANCE_25_MODEL_ID)
      || [SEEDANCE_25_MODEL_ID, BYTEPLUS_SEEDANCE_25_MODEL_ID].includes(String(input.requestPayload.model || "").trim() as typeof SEEDANCE_25_MODEL_ID)
    );
  if (!arkProtocol && exactSeedance25Requested && (!canonicalVideoGeneration || !videoProviderAdapter)) {
    throw canonicalVideoBindingError(
      "seedance25_trusted_adapter_required",
      "Seedance 2.5 精确模型只接受服务器校验后的 canonical 请求与正式 Adapter 绑定",
    );
  }
  const structuredTimeline = validateTrustedStructuredTimeline(
    input,
    options.trustedStructuredTimeline ?? null,
    canonicalVideoGeneration,
  );
  const videoAssetPolicyEvidence = arkProtocol ? null : input.endpointType === "video_generation"
    ? await resolveFreshVideoAssetPolicyRelayBinding({
        canonicalRequest: canonicalVideoGeneration?.request ?? null,
        workspaceId: String(input.workspaceId || ""),
        projectId: input.projectId == null ? "" : String(input.projectId),
        evidence: options.trustedVideoAssetPolicyEvidence ?? null,
      })
    : (() => {
        if (options.trustedVideoAssetPolicyEvidence) {
          throw canonicalVideoBindingError(
            "video_asset_policy_endpoint_mismatch",
            "素材策略证据只能绑定视频生成任务",
          );
        }
        return null;
      })();
  if (options.idempotentReplayOnly && !billingAuthorization) {
    throw new BillingError("视频幂等恢复必须携带可信计费授权", 409);
  }
  if (billingAuthorization) {
    assertTrustedVideoBillingAuthorizationInput(billingAuthorization, input);
  }
  // Fail closed before callback resolution, routing, pricing, quota, or provider
  // work. The transaction-bound insert repeats this check under row lock so a
  // concurrent project deletion cannot race task creation.
  await assertRelayTaskProjectAuthority(input);
  const callbackPayload = input.requestPayload;
  const hasCallbackUrl = Boolean(callbackPayload.callback_url || callbackPayload.callbackUrl);
  const hasPlainCallbackSecret = callbackPayload.callback_secret != null || callbackPayload.callbackSecret != null;
  if ((hasCallbackUrl && typeof callbackPayload.callback_secret_ciphertext !== "string") || hasPlainCallbackSecret) {
    input = {
      ...input,
      requestPayload: await prepareRelayCallbackRequestPayload(callbackPayload, { requireClientSecret: !arkProtocol }),
    };
  }
  input = { ...input, requestId: scopeRelayRequestId(input) };
  const existingTask = input.requestId ? await db("o_relay_task").where({ requestId: input.requestId }).first() : null;
  if (existingTask) {
    assertIdempotentRelayTaskScope(existingTask, input);
    if (isArkVideoTask(parseRelayTask(existingTask)) !== arkProtocol) throw arkProtocolError("请求协议与既有任务不一致", 409);
    assertPersistedCanonicalVideoGeneration(existingTask, canonicalVideoGeneration);
    assertPersistedStructuredTimeline(existingTask, structuredTimeline);
    assertPersistedVideoAssetPolicyEvidence(existingTask, videoAssetPolicyEvidence);
    assertPersistedVideoProviderAdapter(existingTask, videoProviderAdapter);
    assertPersistedSeedance25CertificationProbe(
      existingTask,
      certificationProbeContext?.permit ?? null,
    );
    assertPersistedPrivateValidationBudget(existingTask, privateValidationBudget);
    if (!arkProtocol && input.endpointType === "video_generation" && !readRelayPortraitPreparation(parseRelayTask(existingTask))) {
      await resolvePortraitProviderReferencesForChannel({
        workspaceId: String(input.workspaceId || ""),
        projectId: input.projectId == null ? "" : String(input.projectId),
        assetVersionIds: canonicalVideoGeneration?.request.inputs
          .map((item) => item.assetVersionId) ?? [],
        providerChannelId: existingTask.channelId == null
          ? null
          : String(existingTask.channelId),
        requirePortraitRegistration: existingTask.provider === "volcano" && existingTask.model !== "dreamina-seedance-2-5-260628",
        providerModel: existingTask.model,
      });
    }
    let idempotentTask = billingAuthorization
      ? await assertIdempotentAuthorizedRelayTask(existingTask, input, billingAuthorization)
      : assertIdempotentRelayTask(existingTask, input);
    if (privateValidationBudget && isActiveStatus(idempotentTask.status)) {
      idempotentTask = await recoverPrivateValidationBudgetReservation({
        task: idempotentTask,
        relayInput: input,
        binding: privateValidationBudget,
        billingAuthorization,
      });
    }
    return { task: idempotentTask, channel: null };
  }
  if (options.idempotentReplayOnly) {
    const error: any = new Error("未找到可安全重放的既有视频任务");
    error.status = 409;
    error.code = "relay_idempotent_replay_not_found";
    throw error;
  }

  if (canonicalVideoGeneration?.request.operation === "edit") await assertMembershipFeature(String(input.workspaceId || ""), "rewrite");
  let channel: RelayChannel | null = null;
  let videoPlan: VideoResolutionPlan | null = null;
  let fulfillment: FulfillmentPlan | null = null;
  let portraitPreparationRequired = false;
  let portraitProviderDispatch: {
    allowedProviderAssetUris: ReadonlySet<string>;
    requestPayload: Record<string, unknown>;
  } = {
    allowedProviderAssetUris: new Set<string>(),
    requestPayload: input.requestPayload,
  };
  const publicModelRequested = String(input.model || "").trim();
  const highResolutionRequested = isHighPublicVideoResolution(
    input.requestPayload?.resolution,
  );
  const managedValueVideoRequested = isFanjinValueVideoModel(publicModelRequested);

  if (input.endpointType === "video_generation") {
    if (arkProtocol) {
      const draftParent = await arkDraftParent(input, db);
      channel = draftParent ? await selectChannelById(String(draftParent.channelId), input) : await selectChannel(input);
      if (!channel || channel.provider !== "volcano") throw arkProtocolError("所选模型没有可用的方舟兼容通道", 503, "ServiceUnavailable");
      videoPlan = arkVideoPlan(input.requestPayload);
      await assertArkReferenceOwnership(input, channel, db);
    } else if (canonicalVideoGeneration?.request.renderMode === "finalize") {
      const parent = await db("o_relay_task").where({ id: canonicalVideoGeneration.request.draftSource?.taskId }).first();
      const current = resolveDraftParent(parent || null, { workspaceId: String(input.workspaceId), projectId: Number(input.projectId) });
      if (current.digest !== canonicalVideoGeneration.digest) throw canonicalVideoBindingError("draft_parent_changed", "样片关联已变化，请重新报价");
      channel = await selectChannelById(current.request.draftSource!.channelId, { ...input, provider: "volcano" });
      if (!channel) throw canonicalVideoBindingError("draft_channel_unavailable", "样片原通道暂不可用，不会切换其他通道");
      videoPlan = getVideoResolutionPlan(input.requestPayload, { nativeResolutions: ["1080p"] });
    } else if (resolvedCertificationProbe) {
      if (!(await channelHasCapacity(resolvedCertificationProbe.channelRow))) {
        throw seedance25CertificationProbeError(
          "seedance25_certification_probe_channel_capacity_unavailable",
          "Seedance 2.5 首次认证探针指定通道当前没有可用容量",
          503,
        );
      }
      channel = parseRelayChannel(resolvedCertificationProbe.channelRow);
      channel.routeConfig = parseVideoRouteConfig(
        resolvedCertificationProbe.routeRow.routeConfig,
      );
      videoPlan = getVideoResolutionPlan(input.requestPayload, channel.routeConfig, {
        allowTrustedSeedance25Native480p: true,
      });
    } else {
      // Prefer explicit fulfillment recipes (public model × target resolution).
      // 首条尝试 = failover 候选池头部(priority 最小,同 priority 内加权,design §5.1)。
      // Fall back to legacy model-route + routeConfig planning when no recipe exists.
      if (publicModelRequested) {
        try {
          fulfillment = highResolutionRequested || managedValueVideoRequested
            ? await resolveReadyVideoFulfillmentPlan(db as any, {
                workspaceId: String(input.workspaceId || ""),
                publicModel: publicModelRequested,
                resolution: input.requestPayload?.resolution,
              })
            : await resolveFailoverFulfillmentPlan(db as any, {
                publicModel: publicModelRequested,
                resolution: input.requestPayload?.resolution,
              });
        } catch {
          fulfillment = null;
        }
      }
      if (
        managedValueVideoRequested
        && !isExactFanjinValueVideoPlan(publicModelRequested, fulfillment)
      ) {
        const err: any = new Error("当前模型服务暂不可用，请稍后重试");
        err.status = 422;
        err.code = "fanjin_value_video_unavailable";
        throw err;
      }
      if (fulfillment?.generateChannelId) {
        channel = await selectChannelById(fulfillment.generateChannelId, input);
        if (channel) {
          videoPlan = videoPlanFromFulfillment(fulfillment);
        }
      }
      if (!channel && !managedValueVideoRequested) {
        channel = await selectChannel(input);
        videoPlan = getVideoResolutionPlan(input.requestPayload, channel?.routeConfig, {
          allowTrustedSeedance25Native480p: videoProviderAdapter !== null,
          allowProviderNativeNonPublicResolution: (channel?.provider === "minimax" && isMiniMaxH3Model(input.model))
            || (channel?.provider === "autodl" && isAutoDLH3Model(input.model)),
        });
      }
    }
    if (
      !arkProtocol && (highResolutionRequested || managedValueVideoRequested)
      && (
        !videoPlan
        || (videoPlan.needsEnhancement && !videoPlan.recipeId)
      )
    ) {
      const err: any = new Error("当前模型尚未配置可兑现的高分辨率能力");
      err.status = 422;
      err.code = "video_resolution_unavailable";
      throw err;
    }
    // The durable budget counts provider tasks, not Relay rows. Reject a plan
    // that would create a generation task and then a second enhancement task
    // before pricing, task persistence, GU freeze, quota, or provider work.
    assertPrivateValidationBudgetSingleProviderTaskPlan(
      privateValidationBudget,
      videoPlan,
    );
  } else {
    channel = await selectChannel(input);
  }

  if (videoPlan) {
    const providerNativeDeliveryAuthorization =
      createProviderNativeDeliveryAuthorization({
        channel,
        model: input.model,
        plan: videoPlan,
      });
    videoPlan = {
      ...videoPlan,
      ...(providerNativeDeliveryAuthorization
        ? { providerNativeDeliveryAuthorization }
        : {}),
    };
  }

  if (!arkProtocol && input.endpointType === "video_generation") {
    // Accept preparation as durable work before any monetary reservation.
    // Only this exact, non-dispatched pending result can continue automatically.
    try {
      const portraitResolution = await resolvePortraitProviderReferencesForChannel({
        workspaceId: String(input.workspaceId || ""),
        projectId: input.projectId == null ? "" : String(input.projectId),
        assetVersionIds: canonicalVideoGeneration?.request.inputs
          .map((item) => item.assetVersionId) ?? [],
        providerChannelId: channel?.id ?? null,
        providerModel: input.model,
        prepareMissingBindings: true,
        requirePortraitRegistration: channel?.provider === "volcano",
      });
      portraitProviderDispatch = bindPortraitProviderReferencesToPayload({
        canonicalRequest: canonicalVideoGeneration?.request ?? null,
        portraitBindings: portraitResolution.bindings,
        requestPayload: input.requestPayload,
      });
    } catch (error) {
      if (!canonicalVideoGeneration || !channel || privateValidationBudget || certificationProbeContext
        || !isPortraitPreparationPending(error)) throw error;
      portraitPreparationRequired = true;
    }
  }

  if (videoPlan?.invalidResolution) {
    const err: any = new Error(
      videoPlan.publicResolutionForbidden
        ? "平台不提供该分辨率成片，请使用 720p / 1080p / 2K / 4K"
        : "不支持的视频分辨率",
    );
    err.status = 400;
    err.code = videoPlan.publicResolutionForbidden ? "public_resolution_forbidden" : "invalid_resolution";
    throw err;
  }
  if (
    videoProviderAdapter
    && String(videoPlan?.upstreamModel || input.model || "").trim()
      !== videoProviderAdapter.providerModel
  ) {
    throw canonicalVideoBindingError(
      "video_provider_adapter_model_override_forbidden",
      "Seedance 2.5 正式 Adapter 不允许履约配方改写精确供应商模型",
    );
  }
  // Pricing stays on the public model/resolution the user requested (not upstream model).
  const pricingInput = fulfillment
    ? {
        ...input,
        model: fulfillment.publicModel || publicModelRequested || input.model,
        requestPayload: {
          ...input.requestPayload,
          resolution: fulfillment.finalResolution,
        },
      }
    : input;
  const pricing = channel && input.endpointType === "video_generation"
    ? await resolveVideoPricingPlan(pricingInput, channel,
      // Approval-bound Agent quotes without reference evidence retain their
      // approved pricing snapshot. New Canvas/MCP quotes bind measured assets.
      billingAuthorization ? undefined : canonicalVideoGeneration?.request)
    : null;
  if (
    resolvedCertificationProbe
    && (
      !pricing
      || pricing.rule.id !== resolvedCertificationProbe.permit.pricingRuleId
      || channel?.id !== resolvedCertificationProbe.permit.channelId
    )
  ) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_runtime_binding_mismatch",
      "Seedance 2.5 首次认证探针解析出的运行时通道或定价不是 permit 指定对象",
    );
  }
  if (videoProviderAdapter) {
    if (!channel || !pricing) {
      throw canonicalVideoBindingError(
        "seedance25_pricing_route_unavailable",
        "Seedance 2.5 正式 Adapter 未解析到可执行通道与定价",
      );
    }
    assertSeedance25PricingPlan(videoProviderAdapter, channel, pricing, input.requestPayload.resolution);
  }
  if (billingAuthorization) {
    if (!channel || !pricing || input.endpointType !== "video_generation") {
      throw new BillingError("视频计费授权只能用于已解析定价的视频任务", 409);
    }
    assertVideoBillingAuthorization({
      authorization: billingAuthorization,
      pricingInput,
      channel,
      pricing,
    });
  }
  if (options.requireQuickCreatePricingConfirmation) {
    if (!pricing || input.endpointType !== "video_generation") {
      throw new BillingError("视频价格确认只能绑定已解析定价的视频任务", 409);
    }
    assertQuickCreatePricingAuthorization(
      pricing.costMicros,
      options.trustedQuickCreatePricingAuthorization,
    );
  }
  if (privateValidationBudget) {
    if (!channel || !pricing || input.endpointType !== "video_generation" || !input.requestId) {
      throw canonicalVideoBindingError(
        "private_validation_budget_pricing_unavailable",
        "私有验证预算无法绑定精确定价、通道或 requestId",
      );
    }
    const pricingEvidenceSha256 = privateValidationBudgetPricingEvidenceSha256({
      binding: privateValidationBudget,
      relayInput: input,
      channel,
      pricing,
    });
    privateValidationBudgetPricingCheckpoint = {
      format: PRIVATE_VALIDATION_BUDGET_PRICING_CHECKPOINT_FORMAT,
      pricingEvidenceSha256,
      priceSnapshot: { ...pricing.priceSnapshot },
    };
    privateValidationBudget = await reserveReleaseFullMaintenancePrivateValidationBudgetSlotGu({
      binding: privateValidationBudget,
      requestId: input.requestId,
      provider: channel.provider,
      channelId: channel.id,
      model: String(input.model || ""),
      reservationGuMicros: pricing.costMicros,
      pricingEvidenceSha256,
    });
  }
  const now = Date.now();
  const id = uuid();
  const subject = relayRequestSubject(input) || "internal";
  input = {
    ...input,
    requestId: input.requestId || `relay:${input.endpointType}:${subject}:task:${id}`,
  };
  const providerRequestPayload = arkProtocol ? arkProviderPayload(input.requestPayload) : buildProviderRequestPayload(
    input.endpointType === "video_generation"
      ? { ...input, requestPayload: portraitProviderDispatch.requestPayload }
      : input,
    videoPlan,
    {
      allowedProviderAssetUris: portraitProviderDispatch.allowedProviderAssetUris,
      canonicalRequest: canonicalVideoGeneration?.request ?? null,
    },
  );
  const provider = channel?.provider ?? input.provider ?? null;
  const initialStatus: RelayTaskStatus = channel ? "queued" : "failed";
  const initialError = channel ? null : "未配置可用的供应商通道";
  const initialInternal = {
    ...(arkProtocol ? { arkVideoProtocol: arkVideoCheckpoint(input.requestPayload) } : {}),
    ...(portraitPreparationRequired && channel && pricing ? {
      portraitPreparation: {
        version: PORTRAIT_PREPARATION_VERSION,
        state: "waiting",
        requestedAt: now,
        deadlineAt: now + PORTRAIT_PREPARATION_TIMEOUT_MS,
        nextAttemptAt: now,
        attempts: 0,
        maximumCostMicros: pricing.costMicros,
        accountFingerprint: portraitChannelAccountSnapshot(channel).fingerprint,
        initialPolicyEvidenceDigest: videoAssetPolicyEvidence?.evidenceDigest ?? null,
      } satisfies RelayPortraitPreparation,
    } : {}),
    ...(videoPlan ? buildVideoInternalPlan(videoPlan) : {}),
    ...(canonicalVideoGeneration
      ? { canonicalVideoGeneration }
      : {}),
    ...(structuredTimeline ? { structuredTimeline } : {}),
    ...(videoAssetPolicyEvidence ? { videoAssetPolicyEvidence } : {}),
    ...(videoProviderAdapter ? { videoProviderAdapter } : {}),
    ...(certificationProbeContext
      ? { seedance25CertificationProbe: certificationProbeContext.permit }
      : {}),
    ...(privateValidationBudget
      ? {
          [RELEASE_FULL_MAINTENANCE_PRIVATE_VALIDATION_BUDGET_RELAY_EVIDENCE_KEY]:
            privateValidationBudget,
        }
      : {}),
    ...(privateValidationBudgetPricingCheckpoint
      ? {
          [PRIVATE_VALIDATION_BUDGET_PRICING_CHECKPOINT_KEY]:
            privateValidationBudgetPricingCheckpoint,
        }
      : {}),
  };
  const initialResultPayload = {
    ...(Object.keys(initialInternal).length ? { internal: initialInternal } : {}),
    ...(!channel ? { message: "No available provider channel was configured for this request." } : {}),
  };

  try {
    await insertRelayTaskWithProjectAuthority(input, {
      id,
      apiKeyId: input.apiKeyId ?? null,
      workspaceId: input.workspaceId ?? null,
      projectId: input.projectId ?? null,
      requestId: input.requestId,
      endpointType: input.endpointType,
      provider,
      channelId: channel?.id ?? null,
      model: input.model ?? null,
      status: initialStatus,
      requestPayload: stringifyJson(input.requestPayload),
      providerPayload: stringifyJson({
        request: providerRequestPayload,
        ...(portraitPreparationRequired ? { submission: { state: "awaiting_portrait" } } : {}),
        identity: {
          subject: relayRequestSubject(input),
          principalId: input.principalId ?? null,
          actorUserId: input.actorUserId ?? null,
          generationKeyPermission: options.trustedGenerationKeyPermission ?? "relay:video_generation",
          apiKeyId: input.apiKeyId ?? null,
          workspaceId: input.workspaceId ?? null,
          ...(billingAuthorization ? { billingAuthorization } : {}),
          ...(canonicalVideoGeneration
            ? { canonicalVideoGenerationDigest: canonicalVideoGeneration.digest }
            : {}),
        },
      }),
      providerTaskId: null,
      resultPayload: stringifyJson(initialResultPayload),
      errorMessage: initialError,
      quotaReserved: 0,
      apiQuotaReserved: 0,
      costMicros: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      attemptCount: 0,
      heartbeatAt: null,
      createTime: now,
      updateTime: now,
      submittedAt: null,
      completedAt: channel ? null : now,
    }, videoPlan);
  } catch (error) {
    const racedTask = input.requestId ? await db("o_relay_task").where({ requestId: input.requestId }).first() : null;
    if (!racedTask) throw error;
    assertIdempotentRelayTaskScope(racedTask, input);
    if (isArkVideoTask(parseRelayTask(racedTask)) !== arkProtocol) throw arkProtocolError("请求协议与既有任务不一致", 409);
    assertPersistedCanonicalVideoGeneration(racedTask, canonicalVideoGeneration);
    assertPersistedStructuredTimeline(racedTask, structuredTimeline);
    assertPersistedVideoAssetPolicyEvidence(racedTask, videoAssetPolicyEvidence);
    assertPersistedVideoProviderAdapter(racedTask, videoProviderAdapter);
    assertPersistedSeedance25CertificationProbe(
      racedTask,
      certificationProbeContext?.permit ?? null,
    );
    assertPersistedPrivateValidationBudget(racedTask, privateValidationBudget);
    if (!arkProtocol && input.endpointType === "video_generation" && !readRelayPortraitPreparation(parseRelayTask(racedTask))) {
      await resolvePortraitProviderReferencesForChannel({
        workspaceId: String(input.workspaceId || ""),
        projectId: input.projectId == null ? "" : String(input.projectId),
        assetVersionIds: canonicalVideoGeneration?.request.inputs
          .map((item) => item.assetVersionId) ?? [],
        providerChannelId: racedTask.channelId == null ? null : String(racedTask.channelId),
        requirePortraitRegistration: racedTask.provider === "volcano" && racedTask.model !== "dreamina-seedance-2-5-260628",
        providerModel: racedTask.model,
      });
    }
    let idempotentTask = billingAuthorization
      ? await assertIdempotentAuthorizedRelayTask(racedTask, input, billingAuthorization)
      : assertIdempotentRelayTask(racedTask, input);
    if (privateValidationBudget && isActiveStatus(idempotentTask.status)) {
      idempotentTask = await recoverPrivateValidationBudgetReservation({
        task: idempotentTask,
        relayInput: input,
        binding: privateValidationBudget,
        billingAuthorization,
      });
    }
    return { task: idempotentTask, channel: null };
  }

  if (privateValidationBudget) {
    throwPrivateValidationBudgetFailpoint("after_task_before_freeze");
  }

  if (!channel) {
    const row = await db("o_relay_task").where({ id }).first();
    return { task: parseRelayTask(row), channel };
  }

  if (portraitPreparationRequired) {
    return { task: parseRelayTask(await db("o_relay_task").where({ id }).first()), channel };
  }

  try {
    if (input.endpointType === "video_generation") {
      if (!pricing) throw new BillingError("视频任务缺少冻结价格快照", 500);
      if (!videoPlan) throw new BillingError("视频任务缺少分辨率执行计划", 500);
      await reserveVideoBilling(
        id,
        input,
        channel,
        pricing,
        videoPlan,
        billingAuthorization,
        "",
        certificationProbeContext,
      );
      if (privateValidationBudget) {
        throwPrivateValidationBudgetFailpoint("after_freeze_before_quota");
      }
      const reservedTask = await getRelayTask(id);
      if (!reservedTask) throw new BillingError("视频任务创建后不存在", 500);
      await reserveRelayTaskApiQuota(reservedTask);
    } else {
      await reserveQuota({
        ...input,
        provider,
        taskId: id,
        channelId: channel.id,
      } as CreateRelayTaskInput & { taskId: string; channelId?: string | null });
    }
  } catch (err: any) {
    if (
      privateValidationBudget
      && isPrivateValidationBudgetFailpoint(err, "after_freeze_before_quota")
    ) {
      // Test-only hard-kill simulation: intentionally skip compensating
      // cleanup so the idempotent replay must recover freeze -> quota.
      throw err;
    }
    const failedAt = Date.now();
    const currentTask = await getRelayTask(id);
    let mayEnterTerminalState = true;
    if (currentTask && input.endpointType === "video_generation") {
      const openFreeze = await db("o_billing_ledger")
        .where({ workspaceId: currentTask.workspaceId, type: "freeze", relatedTaskId: currentTask.id })
        .where("remainingMicros", ">", 0)
        .first();
      if (openFreeze) {
        try {
          await releaseVideoBilling(currentTask, "视频任务调用上游前失败，释放预扣");
        } catch (releaseError: any) {
          try {
            await markVideoBillingPending(currentTask, channel, "creation_predispatch_release_failed", {
              providerDispatchConfirmed: false,
              releaseError: redactRelayText(releaseError?.message || releaseError),
            });
          } catch (pendingError) {
            mayEnterTerminalState = false;
            await keepVideoBillingRetryable(currentTask, "creation_billing_finalization_failed", pendingError, {
              submission: {
                ...videoSubmission(currentTask),
                state: "pending_reconcile_persist_failed",
                retryAllowed: false,
              },
            });
          }
        }
      }
      if (mayEnterTerminalState) await completeRelayTaskApiQuota((await getRelayTask(id)) || currentTask, false).catch(() => undefined);
    }
    if (mayEnterTerminalState) {
      await db("o_relay_task").where({ id }).update({
        status: "failed",
        resultPayload: stringifyJson({
          ...initialResultPayload,
          message: err?.message || "Quota reservation failed",
        }),
        errorMessage: err?.message || "Quota reservation failed",
        updateTime: failedAt,
        completedAt: failedAt,
      });
    }
    if (input.endpointType !== "video_generation") await completeRelayBilling(id, "failed");
    throw err;
  }

  if (input.endpointType === "video_generation") {
    throwImmediateTerminalFailpoint("after_reservation");
  }

  // This synthetic `custom` completion is a local fixture, not a production
  // provider implementation. Keep it exclusive to the explicit test runtime so
  // misconfigured production/development channels fail and release billing via
  // the unsupported-provider branch below instead of charging for fake output.
  if (channel.provider === "custom" && process.env.NODE_ENV === "test") {
    let reservedMockTask = await getRelayTask(id);
    let mockBillingResolution: ImmediateVideoBillingResolution | null = null;
    if (reservedMockTask && input.endpointType === "video_generation") {
      reservedMockTask = await claimRelayTaskForImmediateBilling(
        reservedMockTask,
      );
      try {
        const captured = await settleVideoSubmissionBilling(
          reservedMockTask,
          channel,
        );
        if (!captured) {
          throw new BillingError(
            "自定义测试视频未形成可验证的即时扣费终态",
            409,
          );
        }
      } catch (error: any) {
        try {
          await markVideoBillingPending(reservedMockTask, channel, "custom_mock_settlement_failed", {
            settlementError: redactRelayText(error?.message || error),
          });
        } catch (pendingError) {
          await keepVideoBillingRetryable(reservedMockTask, "custom_mock_billing_finalization_failed", pendingError);
          throw pendingError;
        }
      }
      mockBillingResolution =
        await readImmediateVideoBillingResolution(reservedMockTask);
      if (mockBillingResolution.state === "released") {
        throw new BillingError(
          "自定义测试视频冻结流水意外进入释放终态",
          409,
        );
      }
      await completeRelayTaskApiQuota((await getRelayTask(id)) || reservedMockTask, true);
    }
    const mockBillingFinalizedAt =
      mockBillingResolution?.state === "captured"
        ? Date.now()
        : null;
    const mockPatch = {
      status: "mocked",
      providerPayload: stringifyJson({
        ...(reservedMockTask?.providerPayload || {}),
        ...(input.endpointType === "video_generation"
          ? {
              submission: {
                ...videoSubmission(reservedMockTask!),
                state: mockBillingResolution!.state,
                billingFinalizedAt: mockBillingFinalizedAt,
                reconcileJobId:
                  mockBillingResolution!.reconcileJobId,
              },
            }
          : {}),
      }),
      resultPayload: stringifyJson({
        mock: true,
        message: "Custom provider test channel returned a local mock result.",
        assets: [],
        ...(videoPlan
          ? {
              internal: buildVideoInternalPlan(
                videoPlan,
                reservedMockTask?.resultPayload.internal,
              ),
            }
          : {}),
      }),
      errorMessage: null,
    };
    if (input.endpointType === "video_generation") {
      if (!reservedMockTask) {
        throw new BillingError("Relay 视频即时测试终态缺少任务", 500);
      }
      throwImmediateTerminalFailpoint("after_billing");
      reservedMockTask = await completeImmediateRelayTask(
        reservedMockTask,
        mockPatch,
      );
    } else {
      await db("o_relay_task").where({ id }).update({
        ...mockPatch,
        updateTime: Date.now(),
        completedAt: Date.now(),
      });
    }
    if (input.endpointType !== "video_generation") await completeRelayBilling(id, "mocked");
  } else if (!isAsyncVideoRelayProvider(channel.provider) || input.endpointType !== "video_generation") {
    let unsupportedTask = await getRelayTask(id);
    let unsupportedBillingResolution:
      ImmediateVideoBillingResolution | null = null;
    if (unsupportedTask && input.endpointType === "video_generation") {
      unsupportedTask = await claimRelayTaskForImmediateBilling(
        unsupportedTask,
      );
      try {
        await releaseVideoBilling(unsupportedTask, "视频供应商不支持该接口，释放预扣");
      } catch (releaseError: any) {
        try {
          await markVideoBillingPending(unsupportedTask, channel, "unsupported_provider_release_failed", {
            providerDispatchConfirmed: false,
            releaseError: redactRelayText(releaseError?.message || releaseError),
          });
        } catch (pendingError) {
          await keepVideoBillingRetryable(unsupportedTask, "unsupported_provider_billing_finalization_failed", pendingError, {
            submission: { ...videoSubmission(unsupportedTask), state: "pending_reconcile_persist_failed", retryAllowed: false },
          });
          throw pendingError;
        }
      }
      unsupportedBillingResolution =
        await readImmediateVideoBillingResolution(unsupportedTask);
      if (unsupportedBillingResolution.state === "captured") {
        throw new BillingError(
          "不受支持的视频供应商冻结流水意外进入扣费终态",
          409,
        );
      }
      await completeRelayTaskApiQuota((await getRelayTask(id)) || unsupportedTask, false);
    }
    const unsupportedBillingFinalizedAt =
      unsupportedBillingResolution?.state === "released"
        ? Date.now()
        : null;
    const unsupportedPatch = {
      status: "failed",
      providerPayload: stringifyJson({
        ...(unsupportedTask?.providerPayload || {}),
        ...(input.endpointType === "video_generation"
          ? {
              submission: {
                ...videoSubmission(unsupportedTask!),
                state: unsupportedBillingResolution!.state,
                billingFinalizedAt:
                  unsupportedBillingFinalizedAt,
                reconcileJobId:
                  unsupportedBillingResolution!.reconcileJobId,
              },
            }
          : {}),
      }),
      resultPayload: stringifyJson({
        message: "Provider channel is not supported for this endpoint.",
        provider: channel.provider,
        endpointType: input.endpointType,
        ...(videoPlan
          ? {
              internal: buildVideoInternalPlan(
                videoPlan,
                unsupportedTask?.resultPayload.internal,
              ),
            }
          : {}),
      }),
      errorMessage: "供应商通道暂不支持该接口",
    };
    if (input.endpointType === "video_generation") {
      if (!unsupportedTask) {
        throw new BillingError("Relay 视频即时失败终态缺少任务", 500);
      }
      throwImmediateTerminalFailpoint("after_billing");
      unsupportedTask = await completeImmediateRelayTask(
        unsupportedTask,
        unsupportedPatch,
      );
    } else {
      await db("o_relay_task").where({ id }).update({
        ...unsupportedPatch,
        updateTime: Date.now(),
        completedAt: Date.now(),
      });
    }
    if (input.endpointType !== "video_generation") await completeRelayBilling(id, "failed");
  }

  const row = await db("o_relay_task").where({ id }).first();
  return {
    task: parseRelayTask(row),
    channel,
  };
}

export async function createRelayTask(
  input: CreateRelayTaskInput,
  options: CreateRelayTaskOptions = {},
): Promise<{ task: RelayTask; channel: RelayChannel | null }> {
  return await createRelayTaskInternal(input, options, null);
}

function seedance25CertificationProbeRelayInput(input: {
  permit: Seedance25CertificationProbePermit;
  prepared: ReturnType<typeof prepareSeedance25CertificationProbeRequest>;
}): CreateRelayTaskInput {
  return {
    endpointType: "video_generation",
    requestPayload: input.prepared.requestPayload,
    apiKeyId: null,
    principalId: input.prepared.principalId,
    // 探针许可已验证管理员身份；首次提交仍检查该提交者的实时授权。
    actorUserId: Number(input.permit.adminUserId),
    workspaceId: input.permit.workspaceId,
    projectId: Number(input.permit.projectId),
    requestId: input.prepared.requestId,
    model: SEEDANCE_25_MODEL_ID,
    provider: "volcano",
  };
}

async function recoverSeedance25CertificationProbeReservation(input: {
  task: RelayTask;
  context: Seedance25CertificationProbeInternalContext;
  prepared: ReturnType<typeof prepareSeedance25CertificationProbeRequest>;
}): Promise<RelayTask> {
  const resolved = await resolveSeedance25CertificationProbe(
    input.context.permit.probeId,
  );
  assertSeedance25CertificationProbeContext(input.context, resolved);
  const rawRelayInput = seedance25CertificationProbeRelayInput({
    permit: input.context.permit,
    prepared: input.prepared,
  });
  const relayInput = normalizeRelayTaskInput({
    ...rawRelayInput,
    requestId: input.prepared.scopedRequestId,
  });
  const task = (await getRelayTask(input.task.id)) || input.task;
  const identity = parseJsonObject(task.providerPayload.identity);
  if (
    task.apiKeyId !== null
    || task.workspaceId !== input.context.permit.workspaceId
    || task.projectId !== Number(input.context.permit.projectId)
    || task.requestId !== relayInput.requestId
    || task.endpointType !== "video_generation"
    || task.provider !== "volcano"
    || task.channelId !== input.context.permit.channelId
    || task.model !== SEEDANCE_25_MODEL_ID
    || identity.principalId !== input.prepared.principalId
    || identity.subject !== `principal:${input.prepared.principalId}`
    || stableStringifyJson(task.requestPayload)
      !== stableStringifyJson(input.prepared.requestPayload)
  ) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_task_identity_mismatch",
      "Seedance 2.5 首次认证探针既有任务身份或固定 requestId 已发生变化",
    );
  }
  const storedInternal = parseJsonObject(task.resultPayload.internal);
  if (!Object.keys(parseJsonObject(storedInternal.canonicalVideoGeneration)).length) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_canonical_checkpoint_missing",
      "Seedance 2.5 首次认证探针既有任务缺少 canonical 请求检查点",
    );
  }
  assertPersistedCanonicalVideoGeneration(task, {
    request: input.prepared.canonicalRequest,
    digest: input.prepared.canonicalDigest,
  });
  assertPersistedVideoProviderAdapter(
    task,
    input.prepared.relayAdapterBinding,
  );
  assertPersistedSeedance25CertificationProbe(task, input.context.permit);

  if (isTerminalStatus(task.status) || task.providerTaskId || hasVideoDispatchEvidence(task)) {
    return task;
  }
  if (!isActiveStatus(task.status)) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_task_state_invalid",
      "Seedance 2.5 首次认证探针既有任务状态不可恢复",
    );
  }
  if (
    task.leaseOwner
    && Number.isSafeInteger(task.leaseExpiresAt)
    && Number(task.leaseExpiresAt) > Date.now()
  ) {
    return task;
  }
  const existingReservation = await readVideoBillingReservation(task, false);
  if (existingReservation) return task;

  const latestBeforeReserve = (await getRelayTask(task.id)) || task;
  if (
    latestBeforeReserve.providerTaskId
    || hasVideoDispatchEvidence(latestBeforeReserve)
  ) {
    return latestBeforeReserve;
  }
  const channel = parseRelayChannel(resolved.channelRow);
  channel.routeConfig = parseVideoRouteConfig(resolved.routeRow.routeConfig);
  const pricing = await resolveVideoPricingPlan(relayInput, channel);
  if (pricing.rule.id !== input.context.permit.pricingRuleId) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_runtime_binding_mismatch",
      "Seedance 2.5 首次认证探针恢复时解析到不同定价规则",
    );
  }
  const videoPlan = getVideoResolutionPlan(
    relayInput.requestPayload,
    channel.routeConfig,
    { allowTrustedSeedance25Native480p: true },
  );
  assertSeedance25PricingPlan(
    input.prepared.relayAdapterBinding,
    channel,
    pricing,
    relayInput.requestPayload.resolution,
  );
  await reserveVideoBilling(
    task.id,
    relayInput,
    channel,
    pricing,
    videoPlan,
    null,
    "",
    input.context,
  );
  return (await getRelayTask(task.id)) || task;
}

/**
 * Server-internal, idempotent first-certification boundary for the exact
 * Seedance 2.5 route. There is deliberately no HTTP router for this function.
 * Its sole argument is the operator-written probeId; every commercial and
 * provider-facing fact is reconstructed from the validated DB permit.
 */
let seedance25CertificationProbeCreateTail: Promise<void> = Promise.resolve();

async function acquireSeedance25CertificationProbeCreateSlot(): Promise<() => void> {
  const previous = seedance25CertificationProbeCreateTail;
  let release: () => void = () => {};
  seedance25CertificationProbeCreateTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  return release;
}

export async function createSeedance25CertificationProbeRelayTask(
  probeId: string,
): Promise<RelayTask> {
  if (arguments.length !== 1) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_arguments_forbidden",
      "Seedance 2.5 首次认证探针只接受 probeId，禁止覆盖 requestId 或派发参数",
      400,
    );
  }
  return await createSeedance25CertificationProbeRelayTaskInternal(probeId, null);
}

/**
 * Dedicated release-validation wrapper. The legacy one-argument certification
 * boundary remains unchanged; the second argument is an exact DB-verified
 * server-only budget slot and cannot override any provider or permit fact.
 */
export async function createSeedance25CertificationProbeRelayTaskWithBudget(
  probeId: string,
  bindingValue: ReleaseFullMaintenancePrivateValidationBudgetSlotBinding,
): Promise<RelayTask> {
  if (arguments.length !== 2) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_budget_arguments_invalid",
      "带预算的 Seedance 2.5 认证探针必须精确携带 probeId 和预算槽",
      400,
    );
  }
  const binding = assertReleaseFullMaintenancePrivateValidationBudgetSlotBinding(bindingValue);
  if (binding.slot !== "seedance") {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_budget_slot_mismatch",
      "Seedance 2.5 认证探针只能消费 seedance 预算槽",
    );
  }
  return await createSeedance25CertificationProbeRelayTaskInternal(probeId, binding);
}

async function createSeedance25CertificationProbeRelayTaskInternal(
  probeId: string,
  privateValidationBudget: ReleaseFullMaintenancePrivateValidationBudgetSlotBinding | null,
): Promise<RelayTask> {
  // This session-scoped fence deliberately spans the internal transactions in
  // createRelayTaskInternal + reserveVideoBilling. A re-arm therefore cannot
  // observe zero tasks/freezes and replace the permit while an older create is
  // between resolve, durable insert and GU reservation. It is released before
  // refreshRelayTask, so no provider I/O runs under the control-plane fence.
  // The local slot prevents same-process callers from consuming every pool
  // connection while waiting for the same session advisory fence.
  const releaseCreateSlot = await acquireSeedance25CertificationProbeCreateSlot();
  let releaseFence: (() => Promise<void>) | null = null;
  let taskToDispatch: RelayTask | null = null;
  try {
    releaseFence = await acquireModelRouteCertificationSessionFence(db);
    const resolved = await resolveSeedance25CertificationProbe(probeId);
    await waitSeedance25CertificationProbeTestBarrier("after_probe_resolve");
    const prepared = prepareSeedance25CertificationProbeRequest({
      permit: resolved.permit,
      pricingReadback: resolved.pricingReadback,
    });
    if (prepared.canonicalRequest.inputs.length !== 0) {
      throw seedance25CertificationProbeError(
        "seedance25_certification_probe_assets_forbidden",
        "Seedance 2.5 首次认证探针禁止携带任何参考素材",
      );
    }
    const policy = await resolveVideoAssetPolicyDecisions({
      workspaceId: resolved.permit.workspaceId,
      projectId: resolved.permit.projectId,
      assetVersionIds: [],
    });
    if (!policy.trustedEvidence || policy.decisions.length !== 0
      || policy.trustedEvidence.assetVersionIds.length !== 0) {
      throw seedance25CertificationProbeError(
        "seedance25_certification_probe_empty_policy_evidence_invalid",
        "Seedance 2.5 首次认证探针缺少可信的空素材策略证据",
      );
    }
    const context: Seedance25CertificationProbeInternalContext = {
      brand: SEEDANCE_25_CERTIFICATION_PROBE_BRAND,
      permit: resolved.permit,
      pricingReadback: resolved.pricingReadback,
    };
    const relayInput = seedance25CertificationProbeRelayInput({
      permit: resolved.permit,
      prepared,
    });
    const created = await createRelayTaskInternal(
      relayInput,
      {
        trustedCanonicalVideoGeneration: {
          request: prepared.canonicalRequest,
          digest: prepared.canonicalDigest,
        },
        trustedVideoProviderAdapter: prepared.relayAdapterBinding,
        trustedVideoAssetPolicyEvidence: policy.trustedEvidence,
        trustedPrivateValidationBudget: privateValidationBudget,
      },
      context,
    );
    const task = await recoverSeedance25CertificationProbeReservation({
      task: created.task,
      context,
      prepared,
    });
    if (isTerminalStatus(task.status) || task.providerTaskId || hasVideoDispatchEvidence(task)) {
      return task;
    }
    const reservation = await readVideoBillingReservation(task, false);
    if (!reservation || reservation.remainingMicros <= 0) return task;
    throwSeedance25CertificationProbeFailpoint("after_reservation");
    taskToDispatch = task;
  } finally {
    try {
      await releaseFence?.();
    } finally {
      releaseCreateSlot();
    }
  }
  if (!taskToDispatch) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_dispatch_state_invalid",
      "Seedance 2.5 首次认证探针缺少可派发的已预占任务",
    );
  }
  return await refreshRelayTask(taskToDispatch);
}

export interface ListRelayTasksInput {
  endpointType?: RelayEndpointType;
  status?: string | null;
  model?: string | null;
  serviceTier?: "default" | "flex";
  publicVideoStatus?: boolean;
  taskIds?: string[];
  workspaceId?: string | null;
  apiKeyId?: string | null;
  pageNum?: number;
  pageSize?: number;
}

function normalizePublicStatus(status: RelayTaskStatus): string {
  return publicRelayStatus(status);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeProgressValue(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const numeric = typeof value === "number" ? value : Number.parseFloat(String(value).replace("%", ""));
  if (!Number.isFinite(numeric)) return null;
  if (numeric > 0 && numeric <= 1) return clampPercent(numeric * 100);
  return clampPercent(numeric);
}

function readProgressFromPayload(payload: Record<string, unknown> | null | undefined): number | null {
  if (!payload) return null;
  const value = pickFirst(payload, [
    "progress",
    "percent",
    "percentage",
    "progress_percent",
    "progressPercent",
    "data.progress",
    "data.percent",
    "data.percentage",
    "data.progress_percent",
    "data.progressPercent",
    "result.progress",
    "result.percent",
    "result.percentage",
    "output.progress",
    "task.progress",
  ]);
  return normalizeProgressValue(value);
}

function firstKnownProgress(...payloads: Array<Record<string, unknown> | null | undefined>): number | null {
  for (const payload of payloads) {
    const progress = readProgressFromPayload(payload);
    if (progress !== null) return progress;
  }
  return null;
}

function estimateElapsedProgress(startedAt: number | null | undefined, estimateMs: number, floor = 0, ceiling = 95): number {
  const start = Number(startedAt || 0);
  if (!start || !Number.isFinite(start)) return floor;
  const elapsed = Math.max(0, Date.now() - start);
  const ratio = Math.min(1, elapsed / Math.max(estimateMs, 1));
  return floor + (ceiling - floor) * ratio;
}

function scaleProgress(progress: number, start: number, end: number): number {
  const normalized = Math.max(0, Math.min(100, progress));
  return clampPercent(start + ((end - start) * normalized) / 100);
}

function generationProgress(task: RelayTask): number | null {
  return firstKnownProgress(
    task.resultPayload,
    task.resultPayload?.provider as Record<string, unknown>,
    task.providerPayload?.response as Record<string, unknown>,
    task.providerPayload,
  );
}

function targetProcessingProgress(task: RelayTask): number | null {
  const enhancement = task.resultPayload?.enhancement as Record<string, unknown> | undefined;
  return firstKnownProgress(enhancement?.payload as Record<string, unknown>, enhancement, task.resultPayload);
}

export function getRelayTaskProgress(task: RelayTask): RelayTaskProgress {
  const plan = task.endpointType === "video_generation"
    ? restoreVideoResolutionPlanFromInternal(task.resultPayload, task.requestPayload)
    : null;
  const needsTargetProcessing = Boolean(plan?.needsEnhancement);
  const targetResolution = plan?.requestedResolution ?? null;
  const publicStatus = normalizePublicStatus(task.status);

  if (isRelayPortraitPreparing(task)) {
    return { status: "queued", stage: "queued", stageLabel: "素材登记中", progress: 0,
      progressPercent: 0, targetResolution, needsTargetProcessing };
  }

  if (publicStatus === "succeeded") {
    return {
      status: publicStatus,
      stage: "completed",
      stageLabel: "已完成",
      progress: 100,
      progressPercent: 100,
      targetResolution,
      needsTargetProcessing,
    };
  }

  if (publicStatus === "failed") {
    const synthetic = task.status === "mocked";
    const progress = synthetic
      ? 0
      : needsTargetProcessing
        ? (task.providerTaskId ? 70 : 20)
        : Math.max(10, generationProgress(task) ?? 0);
    return {
      status: "failed",
      stage: "failed",
      stageLabel: synthetic ? "测试模拟（非真实结果）" : "失败",
      progress: clampPercent(progress),
      progressPercent: clampPercent(progress),
      targetResolution,
      needsTargetProcessing,
    };
  }

  if (task.status === "cancelled") {
    const progress = Math.max(0, generationProgress(task) ?? 0);
    return {
      status: "cancelled",
      stage: "cancelled",
      stageLabel: "已取消",
      progress: clampPercent(progress),
      progressPercent: clampPercent(progress),
      targetResolution,
      needsTargetProcessing,
    };
  }

  if (task.status === "enhancing") {
    const enhancement = task.resultPayload?.enhancement as Record<string, unknown> | undefined;
    const startedAt = Number(enhancement?.startedAt || task.submittedAt || task.updateTime || task.createTime);
    const rawProgress =
      targetProcessingProgress(task) ??
      estimateElapsedProgress(startedAt, Number(process.env.FANJIN_VIDEO_ENHANCE_PROGRESS_ESTIMATE_MS || 6 * 60 * 1000), 4, 96);
    const progress = scaleProgress(rawProgress, 72, 98);
    return {
      status: "running",
      stage: "processing",
      stageLabel: "高清处理中",
      progress,
      progressPercent: progress,
      targetResolution,
      needsTargetProcessing,
    };
  }

  if (task.status === "running") {
    const rawProgress =
      generationProgress(task) ??
      estimateElapsedProgress(task.submittedAt || task.createTime, Number(process.env.FANJIN_VIDEO_GENERATION_PROGRESS_ESTIMATE_MS || 12 * 60 * 1000), 5, 92);
    const progress = needsTargetProcessing ? scaleProgress(rawProgress, 5, 70) : scaleProgress(rawProgress, 5, 98);
    return {
      status: "running",
      stage: "generating",
      stageLabel: "视频生成中",
      progress,
      progressPercent: progress,
      targetResolution,
      needsTargetProcessing,
    };
  }

  return {
    status: "running",
    stage: "queued",
    stageLabel: "排队中",
    progress: 2,
    progressPercent: 2,
    targetResolution,
    needsTargetProcessing,
  };
}

function toUnixSeconds(value: number | null | undefined): number | null {
  return value ? Math.floor(Number(value) / 1000) : null;
}

export async function getRelayTask(id: string): Promise<RelayTask | null> {
  const row = await db("o_relay_task").where({ id }).first();
  return row ? parseRelayTask(row) : null;
}

async function claimRelayTask(task: RelayTask): Promise<RelayTask | null> {
  if (isTerminalStatus(task.status) || !isActiveStatus(task.status)) return null;
  const timestamp = Date.now();
  const leaseOwner = createRelayLeaseOwner();
  const leaseExpiresAt = timestamp + relayLeaseMs();
  const updateData: Record<string, unknown> = {
    leaseOwner,
    leaseExpiresAt,
    heartbeatAt: timestamp,
    updateTime: timestamp,
  };
  if (!task.providerTaskId) {
    updateData.attemptCount = db.raw("COALESCE(??, 0) + 1", ["attemptCount"]);
  }

  const affected = await db("o_relay_task")
    .where({ id: task.id, status: task.status })
    .where((builder) => {
      builder.whereNull("leaseExpiresAt").orWhere("leaseExpiresAt", "<", timestamp);
    })
    .update(updateData);
  if (Number(affected || 0) !== 1) return null;
  const claimed = await db("o_relay_task")
    .where({
      id: task.id,
      status: task.status,
      leaseOwner,
      leaseExpiresAt,
    })
    .where("leaseExpiresAt", ">", timestamp)
    .first();
  return claimed ? parseRelayTask(claimed) : null;
}

async function claimRelayTaskForImmediateBilling(
  task: RelayTask,
): Promise<RelayTask> {
  // Immediate terminal billing may only use the mutation fence acquired by
  // this call. Reusing a lease observed on the row would let the creator write
  // through a concurrent worker's fence.
  const claimed = await claimRelayTask(task);
  if (!claimed) {
    throw new BillingError(
      "Relay 视频任务无法取得即时计费 mutation fence",
      409,
    );
  }
  return claimed;
}

async function completeImmediateRelayTask(
  task: RelayTask,
  patch: Record<string, unknown>,
): Promise<RelayTask> {
  if (
    !task.leaseOwner
    || !Number.isSafeInteger(task.leaseExpiresAt)
  ) {
    throw new BillingError(
      "Relay 视频即时终态缺少精确 mutation fence",
      409,
    );
  }
  const timestamp = Date.now();
  const affected = await db("o_relay_task")
    .where({
      id: task.id,
      status: task.status,
      leaseOwner: task.leaseOwner,
      leaseExpiresAt: task.leaseExpiresAt,
    })
    .where("leaseExpiresAt", ">", timestamp)
    .update({
      ...patch,
      updateTime: timestamp,
      completedAt: timestamp,
      ...releaseLeasePatch(),
    });
  if (Number(affected || 0) !== 1) {
    throw new BillingError(
      "Relay 视频即时终态 mutation fence 已失效",
      409,
    );
  }
  const completed = await getRelayTask(task.id);
  if (!completed || !isTerminalStatus(completed.status)) {
    throw new BillingError("Relay 视频即时终态未持久化", 500);
  }
  return completed;
}

function throwImmediateTerminalFailpoint(
  stage: "after_reservation" | "after_billing",
): void {
  if (
    process.env.NODE_ENV === "test"
    && process.env.FANJIN_TEST_RELAY_IMMEDIATE_TERMINAL_FAILPOINT
      === stage
  ) {
    throw new Error(
      `FANJIN_TEST_RELAY_IMMEDIATE_TERMINAL_FAILPOINT:${stage}`,
    );
  }
}

function throwSeedance25CertificationProbeFailpoint(
  stage: "after_reservation",
): void {
  if (
    process.env.NODE_ENV === "test"
    && process.env.FANJIN_TEST_SEEDANCE25_CERTIFICATION_PROBE_FAILPOINT
      === stage
  ) {
    throw new Error(
      `FANJIN_TEST_SEEDANCE25_CERTIFICATION_PROBE_FAILPOINT:${stage}`,
    );
  }
}

function throwPrivateValidationBudgetFailpoint(
  stage:
    | "after_task_before_freeze"
    | "after_freeze_before_quota"
    | "after_task_dispatch_marker_before_billing",
): void {
  if (
    process.env.NODE_ENV === "test"
    && process.env.FANJIN_TEST_PRIVATE_VALIDATION_BUDGET_FAILPOINT === stage
  ) {
    throw new Error(
      `FANJIN_TEST_PRIVATE_VALIDATION_BUDGET_FAILPOINT:${stage}`,
    );
  }
}

function isPrivateValidationBudgetFailpoint(
  error: unknown,
  stage:
    | "after_task_before_freeze"
    | "after_freeze_before_quota"
    | "after_task_dispatch_marker_before_billing",
): boolean {
  return process.env.NODE_ENV === "test"
    && error instanceof Error
    && error.message
      === `FANJIN_TEST_PRIVATE_VALIDATION_BUDGET_FAILPOINT:${stage}`;
}

async function waitSeedance25CertificationProbeTestBarrier(
  stage: "after_probe_resolve",
): Promise<void> {
  if (
    process.env.NODE_ENV !== "test"
    || !isPostgresClient(db)
  ) return;
  const match = String(
    process.env.FANJIN_TEST_SEEDANCE25_CERTIFICATION_PROBE_FAILPOINT || "",
  ).match(new RegExp(`^wait_${stage}:(\\d{1,18})$`, "u"));
  if (match) {
    await db.raw("SELECT pg_advisory_xact_lock(?)", [match[1]]);
  }
}

function relayFinalizationLeaseMs(): number {
  const mediaTimeout = Number(process.env.FANJIN_RELAY_MEDIA_DOWNLOAD_TIMEOUT_MS || 600000);
  const enhanceTimeout = Number(process.env.FANJIN_VIDEO_ENHANCE_TIMEOUT_MS || 600000);
  return Math.max(
    relayLeaseMs(),
    Number.isFinite(mediaTimeout) && mediaTimeout > 0 ? mediaTimeout + 60_000 : 660_000,
    Number.isFinite(enhanceTimeout) && enhanceTimeout > 0 ? enhanceTimeout + 60_000 : 660_000,
  );
}

async function extendRelayTaskLease(
  task: RelayTask,
  durationMs = relayFinalizationLeaseMs(),
): Promise<RelayTask | null> {
  if (!task.leaseOwner || !isActiveStatus(task.status)) return null;
  const now = Date.now();
  const affected = await db("o_relay_task")
    .where({
      id: task.id,
      status: task.status,
      leaseOwner: task.leaseOwner,
    })
    .where("leaseExpiresAt", ">", now)
    .update({
      leaseExpiresAt: now + Math.max(relayLeaseMs(), durationMs),
      heartbeatAt: now,
      updateTime: now,
    });
  return Number(affected || 0) === 1 ? await getRelayTask(task.id) : null;
}

function releaseLeasePatch(): Record<string, unknown> {
  return {
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: Date.now(),
  };
}

async function failRelayTask(task: RelayTask, message: string, providerPatch: Record<string, unknown> = {}): Promise<RelayTask> {
  if (task.leaseOwner) {
    const extendedTask = await extendRelayTaskLease(task);
    if (!extendedTask) return (await getRelayTask(task.id)) || task;
    task = extendedTask;
  }
  const now = Date.now();
  const dispatched = task.endpointType === "video_generation" && hasVideoDispatchEvidence(task);
  if (task.endpointType === "video_generation") {
    const billingChannel: RelayChannel | null = task.provider && task.channelId
      ? {
          id: task.channelId,
          name: "persisted-video-channel",
          provider: task.provider,
          endpointType: "video_generation",
          baseUrl: null,
          credentialRef: null,
          config: {},
          timeoutMs: 0,
        }
      : null;
    let billingFinalizationError: unknown = null;
    try {
      if (dispatched) {
        if (!billingChannel) throw new BillingError("已 dispatch 的视频任务缺少供应商身份，无法核账", 500);
        await markVideoBillingPending(task, billingChannel, "task_failed_after_dispatch", {
          failure: redactRelayText(message),
        });
      } else {
        await releaseVideoBilling(task, message);
      }
    } catch (error) {
      billingFinalizationError = error;
      if (!dispatched && billingChannel) {
        try {
          await markVideoBillingPending(task, billingChannel, "predispatch_release_failed", {
            failure: redactRelayText(message),
            releaseError: redactRelayText((error as any)?.message || error),
            providerDispatchConfirmed: false,
          });
          billingFinalizationError = null;
        } catch (pendingError) {
          billingFinalizationError = pendingError;
        }
      }
    }
    if (billingFinalizationError) {
      const retryQuery = db("o_relay_task").where({ id: task.id }).whereIn("status", ["queued", "running", "enhancing"]);
      if (task.leaseOwner) retryQuery.andWhere({ leaseOwner: task.leaseOwner });
      await retryQuery.update({
        providerPayload: stringifyJson({
          ...(task.providerPayload || {}),
          ...providerPatch,
          billingFinalization: {
            state: "retry_required",
            error: redactRelayText((billingFinalizationError as any)?.message || billingFinalizationError),
            failedAt: now,
            retryAllowedUpstream: false,
          },
        }),
        updateTime: now,
        completedAt: null,
        ...releaseLeasePatch(),
      });
      return (await getRelayTask(task.id)) || task;
    }
  }

  const finalQuery = db("o_relay_task")
    .where({ id: task.id })
    .whereIn("status", ["queued", "running", "enhancing"]);
  if (task.leaseOwner) {
    finalQuery
      .andWhere({ leaseOwner: task.leaseOwner })
      .where("leaseExpiresAt", ">", Date.now());
  }
  const finalAffected = await finalQuery.update({
      status: "failed",
      providerPayload: stringifyJson({
        ...(task.providerPayload || {}),
        ...providerPatch,
      }),
      resultPayload: stringifyJson(mergePersistedVideoPlan(task, { message })),
      errorMessage: message,
      updateTime: now,
      completedAt: now,
      ...releaseLeasePatch(),
    });
  let updatedTask = (await getRelayTask(task.id)) || task;
  if (Number(finalAffected || 0) !== 1) return updatedTask;
  if (task.endpointType === "video_generation") {
    await completeRelayTaskApiQuota(updatedTask, dispatched).catch((error: any) => {
      console.warn("[relay-video] failed to finalize API-key quota", updatedTask.id, error?.message || error);
    });
  } else {
    await completeRelayBilling(task.id, "failed");
    await completeApiKeyQuota(task.apiKeyId, task.id, false);
  }
  if (task.endpointType === "video_generation") {
    await notifyAgentVideoGenerationTaskTerminal({
      database: db,
      taskId: task.id,
      requestId: task.requestId,
      workspaceId: task.workspaceId,
      outcome: "failed",
      errorMessage: redactRelayText(message),
      now,
    }).catch(() => undefined);
  }
  updatedTask = (await getRelayTask(task.id)) || updatedTask;
  if (isTerminalStatus(updatedTask.status)) {
    disposeFormalCandidateVideoDispatchLease(task.id);
  }
  return updatedTask;
}

function relayTaskStaleMs(): number {
  const configured = Number(process.env.FANJIN_RELAY_TASK_STALE_MS || 45 * 60 * 1000);
  return Number.isFinite(configured) && configured > 0 ? configured : 45 * 60 * 1000;
}

async function markVideoSubmissionUncertain(input: {
  task: RelayTask;
  channel: RelayChannel;
  reason: string;
  message: string;
  providerRequestPayload?: Record<string, unknown>;
  providerResponse?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
}): Promise<RelayTask> {
  const now = Date.now();
  const providerPayload = {
    ...(input.task.providerPayload || {}),
    request: input.providerRequestPayload || input.task.providerPayload?.request || {},
    response: input.providerResponse || input.task.providerPayload?.response || {},
    submission: {
      ...videoSubmission(input.task),
      state: "pending_reconcile",
      reconcileReason: input.reason,
      uncertainAt: now,
    },
  };
  try {
    await markVideoBillingPending(input.task, input.channel, input.reason, input.evidence);
  } catch (error: any) {
    const retryPayload = {
      ...providerPayload,
      submission: {
        ...(providerPayload.submission as Record<string, unknown>),
        state: "pending_reconcile_persist_failed",
        pendingPersistenceError: redactRelayText(error?.message || error),
        pendingPersistenceFailedAt: now,
        retryAllowed: false,
      },
    };
    const retryQuery = db("o_relay_task").where({ id: input.task.id }).whereIn("status", ["queued", "running"]);
    if (input.task.leaseOwner) retryQuery.andWhere({ leaseOwner: input.task.leaseOwner });
    await retryQuery.update({
      status: "running",
      providerPayload: stringifyJson(retryPayload),
      errorMessage: null,
      completedAt: null,
      updateTime: now,
      ...releaseLeasePatch(),
    });
    const retryTask = (await getRelayTask(input.task.id)) || input.task;
    await completeRelayTaskApiQuota(retryTask, true).catch((quotaError: any) => {
      console.warn("[relay-video] failed to conservatively consume API-key quota", retryTask.id, quotaError?.message || quotaError);
    });
    return (await getRelayTask(input.task.id)) || retryTask;
  }

  const query = db("o_relay_task").where({ id: input.task.id }).whereIn("status", ["queued", "running"]);
  if (input.task.leaseOwner) query.andWhere({ leaseOwner: input.task.leaseOwner });
  await query.update({
    status: "failed",
    providerPayload: stringifyJson(providerPayload),
    resultPayload: stringifyJson(mergePersistedVideoPlan(input.task, { message: redactRelayText(input.message) })),
    errorMessage: redactRelayText(input.message),
    updateTime: now,
    completedAt: now,
    ...releaseLeasePatch(),
  });
  let current = (await getRelayTask(input.task.id)) || input.task;
  await completeRelayTaskApiQuota(current, true).catch(() => undefined);
  current = (await getRelayTask(input.task.id)) || current;
  if (isTerminalStatus(current.status)) {
    disposeFormalCandidateVideoDispatchLease(input.task.id);
    return await dispatchRelayCallbackIfNeeded(current);
  }
  return current;
}

async function keepVideoBillingRetryable(
  task: RelayTask,
  reason: string,
  error: unknown,
  providerPatch: Record<string, unknown> = {},
  deliveredResult?: Record<string, unknown>,
): Promise<RelayTask> {
  const now = Date.now();
  const query = db("o_relay_task").where({ id: task.id }).whereIn("status", ["queued", "running", "enhancing"]);
  if (task.leaseOwner) query.andWhere({ leaseOwner: task.leaseOwner });
  await query.update({
    // Preserve a verified upstream response even if the billing queue is
    // temporarily unavailable. The active row retries bookkeeping by GET,
    // while the native DTO can already deliver its original URL.
    ...(isArkVideoTask(task) && deliveredResult && hasArkVideoResult(deliveredResult)
      ? { resultPayload: stringifyJson(deliveredResult) } : {}),
    providerPayload: stringifyJson({
      ...(task.providerPayload || {}),
      ...providerPatch,
      billingFinalization: {
        state: "retry_required",
        reason,
        error: redactRelayText((error as any)?.message || error),
        failedAt: now,
        retryAllowedUpstream: false,
      },
    }),
    completedAt: null,
    updateTime: now,
    ...releaseLeasePatch(),
  });
  return (await getRelayTask(task.id)) || task;
}

async function deferVideoPoll(task: RelayTask, input: {
  reason: string;
  message: string;
  httpStatus?: number | null;
  payload?: Record<string, unknown>;
}): Promise<RelayTask> {
  const now = Date.now();
  const persistenceFailure = input.reason === "final_asset_persistence_failed";
  const query = db("o_relay_task").where({ id: task.id, status: task.status });
  if (task.leaseOwner) query.andWhere({ leaseOwner: task.leaseOwner });
  await query.update({
    providerPayload: stringifyJson({
      ...(task.providerPayload || {}),
      poll: {
        reason: input.reason,
        message: redactRelayText(input.message),
        httpStatus: input.httpStatus ?? null,
        payload: input.payload || {},
        retryable: true,
        failedAt: now,
        ...(persistenceFailure ? nextVideoPersistenceRetry(task.providerPayload?.poll, now) : {}),
      },
    }),
    ...(persistenceFailure ? { errorMessage: VIDEO_PERSISTENCE_RETRY_MESSAGE } : {}),
    updateTime: now,
    ...releaseLeasePatch(),
  });
  return (await getRelayTask(task.id)) || task;
}

async function recoverReleasedDefinitiveVideoRejection(task: RelayTask): Promise<RelayTask | null> {
  const submission = videoSubmission(task);
  if (String(submission.state || "") !== "definitive_rejected") return null;

  let reservation = await readVideoBillingReservation(task, false);
  if (!reservation) return null;
  if (reservation.remainingMicros > 0) {
    if (!isDefinitiveVideoRejection({ provider: task.provider, httpStatus: submission.httpStatus, response: task.providerPayload?.response, providerTaskId: task.providerTaskId })) return null;
    try {
      await releaseVideoBilling(task, "供应商明确拒绝视频提交，未创建任务，释放预占", "definitive_not_billable");
    } catch (error) {
      return keepVideoBillingRetryable(task, "definitive_rejection_release_failed", error);
    }
    reservation = await readVideoBillingReservation(task, false);
  }
  if (!reservation || reservation.remainingMicros !== 0 || reservation.usageStatus !== "released") return null;

  const providerResponse = parseJsonObject(task.providerPayload?.response);
  const httpStatus = Number(submission.httpStatus || 0);
  const message = getResponseErrorMessage(
    providerResponse,
    httpStatus > 0 ? `供应商明确拒绝视频提交 (HTTP ${httpStatus})` : "供应商明确拒绝视频提交",
  );
  const realPersonRejection = resolveUpstreamRealPersonRejection(task);
  if (realPersonRejection) {
    await markPortraitUpstreamIdentityRejected({ database: db, workspaceId: String(task.workspaceId || ""),
      assetVersionIds: [realPersonRejection.assetVersionId], reason: "real_person",
      rejectedAt: Number(task.completedAt || task.updateTime) });
  }
  // Keep the original video identity classification path for other refusals.
  if (!realPersonRejection && /single.?person|单人|一致性|identity|portrait|人脸/i.test(message)) {
    const internal = parseJsonObject(parseJsonObject(task.resultPayload).internal);
    const request = parseJsonObject(parseJsonObject(internal.canonicalVideoGeneration).request);
    const inputs: unknown = request.inputs;
    const assetVersionIds = Array.isArray(inputs)
      ? inputs.map((item: any) => Number(item?.assetVersionId)).filter((id: number) => Number.isSafeInteger(id) && id > 0)
      : [];
    await markPortraitUpstreamIdentityRejected({
      database: db,
      workspaceId: String(task.workspaceId || ""),
      assetVersionIds,
    }).catch((error: any) => {
      console.warn("[relay-video] failed to reopen portrait classification after identity reject", task.id, error?.message || error);
    });
  }
  const timestamp = Date.now();
  const query = db("o_relay_task")
    .where({ id: task.id })
    .whereIn("status", ["queued", "running"])
    .whereNull("providerTaskId");
  if (task.leaseOwner) query.andWhere({ leaseOwner: task.leaseOwner });
  await query.update({
    status: "failed",
    resultPayload: stringifyJson(mergePersistedVideoPlan(task, { message })),
    errorMessage: message,
    updateTime: timestamp,
    completedAt: timestamp,
    ...releaseLeasePatch(),
  });

  let recovered = (await getRelayTask(task.id)) || task;
  if (!isTerminalStatus(recovered.status)) return recovered;
  await completeRelayTaskApiQuota(recovered, false).catch((error: any) => {
    console.warn("[relay-video] failed to release API-key quota after recovered rejection", recovered.id, error?.message || error);
  });
  recovered = (await getRelayTask(task.id)) || recovered;
  return await dispatchRelayCallbackIfNeeded(recovered);
}

async function recoverImmediateNonVolcanoVideoTask(
  task: RelayTask,
): Promise<RelayTask> {
  if (
    task.endpointType !== "video_generation"
    || !task.provider
    || task.provider === "volcano"
    || !task.channelId
  ) {
    return task;
  }
  let claimedTask = await claimRelayTask(task);
  if (!claimedTask) return (await getRelayTask(task.id)) || task;

  const channel: RelayChannel = {
    id: claimedTask.channelId!,
    name: "persisted-immediate-video-channel",
    provider: claimedTask.provider!,
    endpointType: "video_generation",
    baseUrl: null,
    credentialRef: null,
    config: {},
    timeoutMs: 0,
  };
  const syntheticMock =
    claimedTask.provider === "custom"
    && process.env.NODE_ENV === "test";
  try {
    const dispatchObserved = Boolean(
      claimedTask.providerTaskId
      || hasVideoDispatchEvidence(claimedTask),
    );
    const initialReservation = await readVideoBillingReservation(
      claimedTask,
      false,
    );
    if (!initialReservation) {
      throw new BillingError(
        "Relay 非 Volcano 视频任务缺少冻结流水，无法恢复终态",
        500,
      );
    }
    if (
      initialReservation.remainingMicros > 0
      && initialReservation.usageStatus !== "pending_reconcile"
    ) {
      try {
        if (dispatchObserved) {
          await markVideoBillingPending(
            claimedTask,
            channel,
            "immediate_non_volcano_dispatch_evidence_requires_reconciliation",
            {
              recovery: true,
              providerTaskId: claimedTask.providerTaskId,
              providerDispatchConfirmed: true,
              submissionState: String(
                videoSubmission(claimedTask).state || "",
              ) || null,
            },
          );
        } else if (syntheticMock) {
          const captured = await settleVideoSubmissionBilling(
            claimedTask,
            channel,
          );
          if (!captured) {
            throw new BillingError(
              "自定义测试视频恢复时未形成可验证扣费终态",
              409,
            );
          }
        } else {
          await releaseVideoBilling(
            claimedTask,
            "非 Volcano 视频供应商不受支持，恢复任务时释放预扣",
          );
        }
      } catch (billingError: any) {
        await markVideoBillingPending(
          claimedTask,
          channel,
          dispatchObserved
            ? "immediate_non_volcano_dispatch_reconciliation_failed"
            : syntheticMock
              ? "custom_mock_settlement_failed"
              : "unsupported_provider_release_failed",
          {
            recovery: true,
            providerDispatchConfirmed: dispatchObserved,
            providerTaskId: claimedTask.providerTaskId,
            billingError: redactRelayText(
              billingError?.message || billingError,
            ),
          },
        );
      }
    }

    const resolution =
      await readImmediateVideoBillingResolution(claimedTask);
    if (syntheticMock && resolution.state === "released") {
      throw new BillingError(
        "自定义测试视频恢复时冻结流水意外进入释放终态",
        409,
      );
    }

    await completeRelayTaskApiQuota(
      (await getRelayTask(task.id)) || claimedTask,
      syntheticMock,
    );
    const fencedTask = (await getRelayTask(task.id)) || claimedTask;
    if (
      fencedTask.leaseOwner !== claimedTask.leaseOwner
      || fencedTask.leaseExpiresAt !== claimedTask.leaseExpiresAt
    ) {
      throw new BillingError(
        "Relay 非 Volcano 视频恢复 mutation fence 已变化",
        409,
      );
    }
    claimedTask = fencedTask;
    const timestamp = Date.now();
    const terminalIsMock = syntheticMock
      && resolution.state === "captured";
    const billingFinalizedAt =
      resolution.state === "pending_reconcile"
        ? null
        : timestamp;
    const completed = await completeImmediateRelayTask(
      claimedTask,
      terminalIsMock
        ? {
            status: "mocked",
            providerPayload: stringifyJson({
              ...(claimedTask.providerPayload || {}),
              submission: {
                ...videoSubmission(claimedTask),
                state: resolution.state,
                billingFinalizedAt,
                reconcileJobId: resolution.reconcileJobId,
                recoveredAt: timestamp,
              },
            }),
            resultPayload: stringifyJson(mergePersistedVideoPlan(
              claimedTask,
              {
                mock: true,
                message:
                  "Custom provider test channel returned a local mock result.",
                assets: [],
              },
            )),
            errorMessage: null,
          }
        : {
            status: "failed",
            providerPayload: stringifyJson({
              ...(claimedTask.providerPayload || {}),
              submission: {
                ...videoSubmission(claimedTask),
                state: resolution.state,
                billingFinalizedAt,
                reconcileJobId: resolution.reconcileJobId,
                recoveredAt: timestamp,
              },
            }),
            resultPayload: stringifyJson(mergePersistedVideoPlan(
              claimedTask,
              {
                message:
                  "Provider channel is not supported for this endpoint.",
                provider: claimedTask.provider,
                endpointType: claimedTask.endpointType,
              },
            )),
            errorMessage: resolution.state === "captured"
              ? "供应商通道不受支持但账务已终结，任务已安全收口"
              : resolution.state === "pending_reconcile"
                ? "检测到供应商派发证据，任务已转人工核账"
                : "供应商通道暂不支持该接口",
          },
    );
    return await dispatchRelayCallbackIfNeeded(completed);
  } catch (error) {
    return await keepVideoBillingRetryable(
      claimedTask,
      "immediate_non_volcano_terminal_recovery_failed",
      error,
    );
  }
}

type RelayPortraitDispatchAuthorization =
  | Readonly<{
      kind: "authorized";
      task: RelayTask;
      channel: RelayChannel;
      providerRequestPayload: Record<string, unknown>;
      formalCredentialRuntime: boolean;
      apiKey: string;
      baseUrl: string;
    }>
  | Readonly<{
      kind: "fence_lost";
      task: RelayTask | null;
    }>
  | Readonly<{
      kind: "channel_failure";
      message: string;
      portraitBound: boolean;
      credential?: ReturnType<typeof getProviderCredentialStatus>;
    }>;

function portraitDispatchGateError(
  code: string,
  message: string,
  retryable = true,
): Error {
  return Object.assign(canonicalVideoBindingError(code, message), { retryable });
}

function portraitChannelAccountSnapshot(channel: RelayChannel): {
  fingerprint: string;
  projectName: string;
} {
  const clean = (value: unknown, maximum = 128): string => {
    const parsed = typeof value === "string" ? value.trim() : "";
    return parsed.length <= maximum ? parsed : "";
  };
  const config = channel.config || {};
  const portraitCredential = isFormalCandidateCredentialRuntimeDeclared()
    ? readProviderChannelPortraitCredentialMetadata(config)
    : inspectProviderChannelPortraitCredential(channel.id, config);
  const providerAccountId = clean(
    config.providerAccountId ?? config.volcengineAccountId ?? config.accountId,
  );
  const projectName = clean(config.assetsProjectName ?? config.projectName);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{2,127}$/u.test(providerAccountId)
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(projectName)
    || !portraitCredential.enabled
    || !portraitCredential.binding
    || portraitCredential.generation < 1
    || ("configured" in portraitCredential && !portraitCredential.configured)
  ) {
    throw portraitDispatchGateError(
      "portrait_provider_account_scope_invalid",
      "所选模型通道缺少可核验的人像资产账号范围，请稍后重试",
    );
  }
  return {
    fingerprint: crypto.createHash("sha256").update(JSON.stringify({
      channelId: channel.id,
      credentialBinding: portraitCredential.binding,
      projectName,
      providerAccountId,
      version: "portrait-provider-account/v2",
    }), "utf8").digest("hex"),
    projectName,
  };
}

type Seedance25CertificationProbeDispatchContext =
  | Readonly<{ kind: "not_probe" }>
  | Readonly<{ kind: "fence_lost"; task: RelayTask | null }>
  | Readonly<{
      kind: "validated";
      task: RelayTask;
      channelRow: Record<string, any>;
      permit: Seedance25CertificationProbePermit;
    }>;

async function lockSeedance25CertificationProbeDispatchTables(
  trx: Knex.Transaction,
): Promise<void> {
  await acquireModelRouteCertificationAdvisoryFence(trx);
  if (!isPostgresClient(trx)) return;
  // The advisory fence serializes certification-control-plane writers. The
  // narrow table fence is retained only for the three non-unique configuration
  // selectors, preventing an unrelated admin writer from inserting a phantom.
  // Never table-lock Relay or billing tables: their legitimate row-lock orders
  // differ and a broad SRE lock can deadlock ordinary customer billing.
  await trx.raw(
    'LOCK TABLE "o_provider_channel", "o_model_route", "o_pricing_rule" IN SHARE ROW EXCLUSIVE MODE',
  );
  const testBarrier = process.env.NODE_ENV === "test"
    ? String(process.env.FANJIN_TEST_SEEDANCE25_CERTIFICATION_PROBE_FAILPOINT || "")
      .match(/^wait_after_dispatch_table_lock:(\d{1,18})$/u)
    : null;
  if (testBarrier) {
    await trx.raw("SELECT pg_advisory_xact_lock(?)", [testBarrier[1]]);
  }
}

async function lockAndAssertSeedance25CertificationProbeBeforeDispatch(
  leasedTask: RelayTask,
  trx: Knex.Transaction,
): Promise<Seedance25CertificationProbeDispatchContext> {
  const leasedInternal = parseJsonObject(leasedTask.resultPayload.internal);
  const storedPermit = parseJsonObject(
    leasedInternal.seedance25CertificationProbe,
  );
  if (!Object.keys(storedPermit).length) return { kind: "not_probe" };

  // The table fence must be the first database lock in this transaction. Once
  // acquired, take row locks serially in the same provider -> route -> pricing
  // -> actor -> project -> workspace -> task order as the operator arm path.
  await lockSeedance25CertificationProbeDispatchTables(trx);

  let permit: Seedance25CertificationProbePermit;
  try {
    permit = assertSeedance25CertificationProbePermit(storedPermit);
  } catch (error: any) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_permit_invalid",
      String(error?.message || "Seedance 2.5 首次认证探针 permit 已失效"),
    );
  }
  const prepared = prepareSeedance25CertificationProbeRequest({
    permit,
    pricingReadback: assertSeedance25PricingBinding(
      parseJsonObject(leasedInternal.videoProviderAdapter).pricingReadback,
    ),
  });

  const channelRow = await trx("o_provider_channel")
    .where({ id: permit.channelId })
    .forUpdate()
    .first();
  const exactRoutes = await trx("o_model_route")
    .where({
      scope: "platform",
      endpointType: "video_generation",
      model: SEEDANCE_25_MODEL_ID,
      provider: "volcano",
    })
    .whereNull("workspaceId")
    .forUpdate();
  const exactPricingRules = await trx("o_pricing_rule")
    .where({
      scope: "platform",
      endpointType: "video_generation",
      model: SEEDANCE_25_MODEL_ID,
      provider: "volcano",
    })
    .whereNull("workspaceId")
    .forUpdate();
  const actor = await trx("o_user")
    .where({ id: Number(permit.adminUserId) })
    .forUpdate()
    .first();
  const project = await trx("o_project")
    .where({ id: Number(permit.projectId), workspaceId: permit.workspaceId })
    .forUpdate()
    .first();
  const workspace = await trx("o_workspace")
    .where({ id: permit.workspaceId })
    .forUpdate()
    .first();
  const taskRow = await trx("o_relay_task")
    .where({
      id: leasedTask.id,
      workspaceId: leasedTask.workspaceId,
      projectId: leasedTask.projectId,
      provider: leasedTask.provider,
      channelId: leasedTask.channelId,
      leaseOwner: leasedTask.leaseOwner,
    })
    .whereIn("status", ["queued", "running"])
    .where("leaseExpiresAt", ">", Date.now())
    .whereNull("providerTaskId")
    .forUpdate()
    .first();
  if (!taskRow) {
    const currentRow = await trx("o_relay_task")
      .where({ id: leasedTask.id })
      .forUpdate()
      .first();
    return {
      kind: "fence_lost",
      task: currentRow ? parseRelayTask(currentRow) : null,
    };
  }
  const task = parseRelayTask(taskRow);
  if (hasVideoDispatchEvidence(task)) {
    return { kind: "fence_lost", task };
  }

  const expectedRequestId = prepared.scopedRequestId;
  const identity = parseJsonObject(task.providerPayload.identity);
  if (
    task.apiKeyId !== null
    || task.workspaceId !== permit.workspaceId
    || task.projectId !== Number(permit.projectId)
    || task.requestId !== expectedRequestId
    || task.endpointType !== "video_generation"
    || task.provider !== "volcano"
    || task.channelId !== permit.channelId
    || task.model !== SEEDANCE_25_MODEL_ID
    || identity.principalId !== prepared.principalId
    || identity.subject !== `principal:${prepared.principalId}`
    || stableStringifyJson(task.requestPayload)
      !== stableStringifyJson(prepared.requestPayload)
  ) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_dispatch_task_mismatch",
      "Seedance 2.5 首次认证探针持久任务身份在派发前不一致",
    );
  }
  assertPersistedCanonicalVideoGeneration(task, {
    request: prepared.canonicalRequest,
    digest: prepared.canonicalDigest,
  });
  assertPersistedVideoProviderAdapter(task, prepared.relayAdapterBinding);
  assertPersistedSeedance25CertificationProbe(task, permit);
  if (exactRoutes.length !== 1 || exactPricingRules.length !== 1) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_dispatch_rows_ambiguous",
      "Seedance 2.5 首次认证探针派发前必须只有一组 exact route/pricing",
    );
  }
  const routeRow = exactRoutes[0] as Record<string, any>;
  const pricingRule = exactPricingRules[0] as Record<string, any>;
  const routeConfig = parseJsonObject(routeRow.routeConfig);
  if (
    stableStringifyJson(routeConfig.certificationProbe)
      !== stableStringifyJson(permit)
    || String(routeRow.id || "") !== permit.routeId
    || Number(routeRow.disabled || 0) !== 0
    || String(routeRow.channelId || "") !== permit.channelId
    || !seedance25ProbeRouteScopeMatches(routeRow, permit.workspaceId)
  ) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_dispatch_route_mismatch",
      "Seedance 2.5 首次认证探针 route 在派发前已漂移",
    );
  }
  if (
    !channelRow
    || String(channelRow.id || "") !== permit.channelId
    || Number(channelRow.disabled || 0) !== 0
    || String(channelRow.endpointType || "") !== "video_generation"
    || String(channelRow.provider || "") !== "volcano"
    || !relayRouteBindingMatchesChannel(routeRow, channelRow, {
      endpointType: "video_generation",
      provider: "volcano",
      workspaceId: permit.workspaceId,
    })
  ) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_dispatch_channel_mismatch",
      "Seedance 2.5 首次认证探针 channel 在派发前已漂移",
    );
  }
  if (
    String(pricingRule.id || "") !== permit.pricingRuleId
    || Number(pricingRule.disabled || 0) !== 0
    || !seedance25ProbePricingScopeMatches(pricingRule, permit.workspaceId)
  ) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_dispatch_pricing_mismatch",
      "Seedance 2.5 首次认证探针 pricing 在派发前已漂移",
    );
  }
  let livePricingReadback: Seedance25PricingReadbackBinding;
  try {
    livePricingReadback = assertSeedance25PricingRuleReadback({
      provider: pricingRule.provider,
      model: pricingRule.model,
      unit: pricingRule.unit,
      currency: pricingRule.currency,
      baseUnitPriceMicros: pricingRule.unitPriceMicros,
      ruleConfig: pricingRule.ruleConfig,
    });
    assertSeedance25ArmedSnapshotForRuntime(routeRow, pricingRule, permit);
  } catch (error: any) {
    throw seedance25CertificationProbeError(
      String(error?.code || "seedance25_certification_probe_dispatch_snapshot_invalid"),
      String(error?.message || "Seedance 2.5 首次认证探针 armed 快照在派发前无效"),
    );
  }
  if (
    stableStringifyJson(livePricingReadback)
      !== stableStringifyJson(prepared.relayAdapterBinding.pricingReadback)
  ) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_dispatch_pricing_readback_mismatch",
      "Seedance 2.5 首次认证探针定价读回在派发前已变化",
    );
  }
  if (
    !actor
    || String(actor.status || "").toLowerCase() !== "active"
    || !["root", "admin", "super_admin"].includes(
      String(actor.role || "").toLowerCase(),
    )
  ) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_dispatch_admin_inactive",
      "Seedance 2.5 首次认证探针管理员在派发前已失活",
      403,
    );
  }
  if (!workspace || String(workspace.status || "").toLowerCase() !== "active") {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_dispatch_workspace_inactive",
      "Seedance 2.5 首次认证探针工作区在派发前已失活",
    );
  }
  if (!project || String(project.deletionState || "") !== "active") {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_dispatch_project_inactive",
      "Seedance 2.5 首次认证探针项目在派发前已失活",
    );
  }
  return { kind: "validated", task, channelRow, permit };
}

function seedance25CertificationProbeDispatchMarkerTime(
  context: Seedance25CertificationProbeDispatchContext,
): number {
  if (
    context.kind === "validated"
    && process.env.NODE_ENV === "test"
    && process.env.FANJIN_TEST_SEEDANCE25_CERTIFICATION_PROBE_FAILPOINT
      === "expire_before_dispatch_marker"
  ) {
    return Date.parse(context.permit.expiresAt);
  }
  return Date.now();
}

function assertSeedance25CertificationProbeDispatchMarkerTime(
  context: Seedance25CertificationProbeDispatchContext,
  submittedAt: number,
): void {
  if (context.kind !== "validated") return;
  const expiresAt = Date.parse(context.permit.expiresAt);
  if (
    !Number.isSafeInteger(submittedAt)
    || !Number.isSafeInteger(expiresAt)
    || submittedAt >= expiresAt
  ) {
    throw seedance25CertificationProbeError(
      "seedance25_certification_probe_expired_at_dispatch_marker",
      "Seedance 2.5 首次认证探针在持久派发标记前已过期",
    );
  }
}

/**
 * The durable dispatch marker is the linearization point for portrait
 * authorization. Every mutable row that can revoke that authorization is
 * locked and re-read in this short transaction. Provider I/O starts only after
 * commit, so a revocation either wins before the marker (zero POST) or is
 * serialized after an already-authorized marker.
 */
async function authorizePortraitRelayDispatch(
  leasedTask: RelayTask,
): Promise<RelayPortraitDispatchAuthorization> {
  const checkpoint = persistedVideoAssetPolicyCheckpoint(leasedTask);
  const assetVersionIds = Array.from(new Set(
    checkpoint.canonicalRequest?.inputs.map((item) => String(item.assetVersionId)) ?? [],
  ));
  const workspaceId = String(leasedTask.workspaceId || "").trim();
  const projectId = leasedTask.projectId;

  return db.transaction(async (trx) => {
    const probeDispatch = await lockAndAssertSeedance25CertificationProbeBeforeDispatch(
      leasedTask,
      trx,
    );
    if (probeDispatch.kind === "fence_lost") {
      return probeDispatch;
    }
    let admissions: Array<Record<string, any>> = [];
    let lockedAssets: Array<Record<string, any>> = [];
    let lockedGroups: Array<Record<string, any>> = [];
    const portraitSchemaAvailable = await trx.schema.hasTable(PORTRAIT_ADMISSION_TABLE);
    if (portraitSchemaAvailable && assetVersionIds.length && workspaceId && projectId != null) {
      admissions = await trx(PORTRAIT_ADMISSION_TABLE)
        .where({ workspaceId, projectId })
        .whereRaw(
          `CAST(?? AS TEXT) IN (${assetVersionIds.map(() => "?").join(", ")})`,
          ["assetVersionId", ...assetVersionIds],
        )
        .select(
          "id",
          "identityId",
          "currentConsentId",
          "currentProviderAssetBindingId",
          "subjectKind",
        )
        .forUpdate();

      const identityIds = Array.from(new Set(
        admissions.map((row) => String(row.identityId || "").trim()).filter(Boolean),
      ));
      if (identityIds.length) {
        await trx(PORTRAIT_IDENTITY_TABLE)
          .where({ workspaceId })
          .whereIn("id", identityIds)
          .select("id")
          .forUpdate();
      }

      const consentIds = Array.from(new Set(
        admissions.map((row) => String(row.currentConsentId || "").trim()).filter(Boolean),
      ));
      if (consentIds.length) {
        await trx(PORTRAIT_CONSENT_TABLE)
          .where({ workspaceId })
          .whereIn("id", consentIds)
          .select("id")
          .forUpdate();
      }

      // An admission can be registered with several model channels. Lock the
      // selected channel's bindings as well as the legacy current pointer:
      // the latter is used by the general policy decision, while dispatch
      // must authorize the exact binding selected for this task's channel.
      const admissionIds = admissions.map((row) => String(row.id));
      const selectedAssetRows = admissionIds.length && leasedTask.channelId
        ? await trx(PORTRAIT_PROVIDER_ASSET_TABLE)
          .where({ workspaceId, channelId: leasedTask.channelId })
          .whereIn("admissionId", admissionIds)
          .select("id")
        : [];
      const providerAssetIds = Array.from(new Set([
        ...admissions.map((row) => String(row.currentProviderAssetBindingId || "").trim()),
        ...selectedAssetRows.map((row) => String(row.id || "").trim()),
      ].filter(Boolean)));
      if (providerAssetIds.length) {
        // Read immutable group ids after the admission lock, then follow the
        // provider worker's group -> asset lock order to avoid deadlocks.
        const assetSeeds = await trx(PORTRAIT_PROVIDER_ASSET_TABLE)
          .where({ workspaceId })
          .whereIn("id", providerAssetIds)
          .select("id", "groupBindingId");
        const groupIds = Array.from(new Set(
          assetSeeds.map((row) => String(row.groupBindingId || "").trim()).filter(Boolean),
        ));
        if (groupIds.length) {
          lockedGroups = await trx(PORTRAIT_PROVIDER_GROUP_TABLE)
            .where({ workspaceId })
            .whereIn("id", groupIds)
            .select(
              "id",
              "identityId",
              "channelId",
              "provider",
              "providerAccountFingerprint",
              "projectName",
              "groupType",
              "state",
            )
            .forUpdate();
        }
        lockedAssets = await trx(PORTRAIT_PROVIDER_ASSET_TABLE)
          .where({ workspaceId })
          .whereIn("id", providerAssetIds)
          .select(
            "id",
            "admissionId",
            "groupBindingId",
            "channelId",
            "providerAssetId",
            "providerAssetUri",
            "sourceSha256",
            "state",
          )
          .forUpdate();
      }
    }

    const portraitBound = admissions.some((row) => (
      ["real_person", "virtual_person", "trusted_output"]
        .includes(String(row.subjectKind || ""))
    ));
    const channelRow = probeDispatch.kind === "validated"
      ? probeDispatch.channelRow
      : await trx("o_provider_channel")
        .where({
          id: leasedTask.channelId,
          provider: leasedTask.provider,
          endpointType: leasedTask.endpointType,
          disabled: 0,
        })
        .where((builder) => builder
          .where((workspace) => workspace.where({ scope: "workspace", workspaceId }))
          .orWhere((platform) => platform.where("scope", "platform").whereNull("workspaceId")))
        .forUpdate()
        .first();
    if (!channelRow) {
      if (portraitBound) {
        throw portraitDispatchGateError(
          "portrait_provider_channel_unsupported",
          "所选人像资产通道已停用或不属于当前工作区，请重新选择模型后重试",
        );
      }
      return {
        kind: "channel_failure",
        message: "供应商通道不存在、已停用或不属于当前工作区。",
        portraitBound,
      };
    }
    const channel = parseRelayChannel(channelRow);
    if (channel.provider !== leasedTask.provider || channel.endpointType !== leasedTask.endpointType) {
      return {
        kind: "channel_failure",
        message: "供应商通道身份与视频任务不匹配。",
        portraitBound,
      };
    }

    const taskRow = probeDispatch.kind === "validated"
      ? probeDispatch.task
      : await trx("o_relay_task")
        .where({
          id: leasedTask.id,
          workspaceId: leasedTask.workspaceId,
          projectId: leasedTask.projectId,
          provider: leasedTask.provider,
          channelId: leasedTask.channelId,
          leaseOwner: leasedTask.leaseOwner,
        })
        .whereIn("status", ["queued", "running"])
        .where("leaseExpiresAt", ">", Date.now())
        .whereNull("providerTaskId")
        .forUpdate()
        .first();
    if (!taskRow) {
      const currentRow = await trx("o_relay_task").where({ id: leasedTask.id }).first();
      return {
        kind: "fence_lost",
        task: currentRow ? parseRelayTask(currentRow) : null,
      };
    }
    const task = parseRelayTask(taskRow);
    if (hasVideoDispatchEvidence(task)) {
      return { kind: "fence_lost", task };
    }

    // 提交者、工作区成员、项目写权限和 API Key 必须与 dispatch_started
    // 标记在同一短事务内完成校验，撤权事务先提交时不会产生供应商 POST。
    await assertRelayGenerationAuthorityInTransaction(task, trx);

    const persistedPortraitDispatch = await validatePersistedVideoAssetPolicyBeforeDispatch(
      task,
      trx,
    );
    if (persistedPortraitDispatch.portraitBindings.length) {
      const account = portraitChannelAccountSnapshot(channel);
      const admissionById = new Map(admissions.map((row) => [String(row.id), row]));
      const assetById = new Map(lockedAssets.map((row) => [String(row.id), row]));
      const groupById = new Map(lockedGroups.map((row) => [String(row.id), row]));
      for (const binding of persistedPortraitDispatch.portraitBindings) {
        const admission = admissionById.get(binding.admissionId);
        const asset = assetById.get(binding.bindingId);
        const group = asset ? groupById.get(String(asset.groupBindingId || "")) : null;
        if (
          !admission
          || !asset
          || String(asset.admissionId || "") !== binding.admissionId
          || String(asset.channelId || "") !== channel.id
          || String(asset.state || "") !== "active"
          || !group
          || String(group.channelId || "") !== channel.id
          || String(group.provider || "") !== "volcano"
          || String(group.state || "") !== "active"
          || String(group.providerAccountFingerprint || "") !== account.fingerprint
          || String(group.projectName || "") !== account.projectName
        ) {
          throw portraitDispatchGateError(
            "portrait_provider_account_binding_stale",
            "人像资产与当前供应商账号范围不一致，请等待重新同步后重试",
          );
        }
      }
    }

    const boundPortraitPayload = bindPortraitProviderReferencesToPayload({
      canonicalRequest: persistedPortraitDispatch.canonicalRequest,
      portraitBindings: persistedPortraitDispatch.portraitBindings,
      requestPayload: readRelayPortraitPreparation(task)?.state === "ready"
        ? parseJsonObject(task.providerPayload.preparedReferenceRequest)
        : task.requestPayload,
    });
    const plan = restoreVideoResolutionPlanFromInternal(task.resultPayload, task.requestPayload);
    const genericProviderRequestPayload = isArkVideoTask(task) ? await arkDispatchPayload(task, trx) : buildProviderRequestPayload({
      endpointType: task.endpointType,
      requestPayload: boundPortraitPayload.requestPayload,
      apiKeyId: task.apiKeyId,
      workspaceId: task.workspaceId,
      requestId: task.requestId,
      model: task.model,
      provider: task.provider,
    }, plan, {
      allowedProviderAssetUris: boundPortraitPayload.allowedProviderAssetUris,
      canonicalRequest: persistedPortraitDispatch.canonicalRequest,
    });
    if (!isAsyncVideoRelayProvider(channel.provider)) {
      return {
        kind: "channel_failure",
        message: "视频生成运行时不支持当前供应商通道。",
        portraitBound,
      };
    }
    const providerRequestPayload = projectVideoRelayProviderRequest(
      channel.provider,
      genericProviderRequestPayload,
    );

    const formalCredentialRuntime = channel.provider === "volcano"
      && isFormalCandidateCredentialRuntimeDeclared();
    const apiKey = formalCredentialRuntime ? "" : resolveProviderApiKey(channel);
    const baseUrl = resolveChannelBaseUrl(channel);
    if (!formalCredentialRuntime && !apiKey) {
      return {
        kind: "channel_failure",
        message: "供应商凭据未配置",
        portraitBound,
        credential: getProviderCredentialStatus(channel),
      };
    }
    if (!baseUrl) {
      return {
        kind: "channel_failure",
        message: "供应商通道未配置 baseUrl。",
        portraitBound,
      };
    }

    const submittedAt = seedance25CertificationProbeDispatchMarkerTime(
      probeDispatch,
    );
    // This exact value becomes both submittedAt and dispatchStartedAt. Recheck
    // it after every lock wait and payload/credential validation so a permit
    // can never cross expiresAt and still reach the durable marker or POST.
    assertSeedance25CertificationProbeDispatchMarkerTime(
      probeDispatch,
      submittedAt,
    );
    const processRole = String(
      process.env.FANJIN_PROCESS_ROLE || process.env.FANJIN_SERVICE_ROLE || "all",
    ).trim().toLowerCase();
    let workerExecution: ReturnType<typeof createRelayWorkerExecutionAttestation> | null = null;
    if (processRole === "worker") {
      const processIdentity = processBootIdentity();
      const heartbeat = await trx("o_worker_heartbeat")
        .where({
          id: processIdentity.incarnationId,
          incarnationId: processIdentity.incarnationId,
        })
        .first() as Record<string, unknown> | undefined;
      workerExecution = createRelayWorkerExecutionAttestation({
        taskId: task.id,
        requestId: String(task.requestId || ""),
        leaseOwner: String(task.leaseOwner || ""),
        dispatchStartedAt: submittedAt,
        heartbeat,
      });
    }
    const runningLeaseExpiresAt = submittedAt + resolveChannelTimeoutMs(channel) + 60_000;
    const resourceReservationId = String(parseJsonObject(task.providerPayload.billing).reservationId || "");
    if (resourceReservationId) await acquireWorkspaceGeneration(trx, { workspaceId, id: resourceReservationId, endpointType: task.endpointType });
    const runningAffected = await trx("o_relay_task")
      .where({
        id: task.id,
        status: task.status,
        leaseOwner: task.leaseOwner,
        leaseExpiresAt: task.leaseExpiresAt,
        channelId: channel.id,
      })
      .whereNull("providerTaskId")
      .whereNull("submittedAt")
      .update({
        status: "running",
        errorMessage: null,
        providerPayload: stringifyJson({
          ...(task.providerPayload || {}),
          request: providerRequestPayload,
          submission: {
            ...videoSubmission(task),
            state: "dispatch_started",
            dispatchStartedAt: submittedAt,
            retryAllowed: false,
            ...(workerExecution ? { workerExecution } : {}),
          },
        }),
        updateTime: submittedAt,
        submittedAt,
        leaseExpiresAt: runningLeaseExpiresAt,
        heartbeatAt: submittedAt,
      });
    if (Number(runningAffected || 0) !== 1) {
      const currentRow = await trx("o_relay_task").where({ id: task.id }).first();
      return {
        kind: "fence_lost",
        task: currentRow ? parseRelayTask(currentRow) : null,
      };
    }
    const authorizedRow = await trx("o_relay_task").where({ id: task.id }).first();
    if (!authorizedRow) return { kind: "fence_lost", task: null };
    const authorizedTask = parseRelayTask(authorizedRow);
    if (storedPrivateValidationBudget(authorizedTask)) {
      // For budget-bound formal validation, the server-only task marker,
      // freeze dispatch marker, watchdog and budget slot transition are one
      // transaction. A hard kill can therefore persist all of them or none.
      throwPrivateValidationBudgetFailpoint(
        "after_task_dispatch_marker_before_billing",
      );
      await markVideoBillingDispatched(authorizedTask, channel, trx);
    }
    return {
      kind: "authorized",
      task: authorizedTask,
      channel,
      providerRequestPayload,
      formalCredentialRuntime,
      apiKey,
      baseUrl,
    };
  });
}

async function submitRelayTaskToProvider(task: RelayTask): Promise<RelayTask> {
  if (!["queued", "running"].includes(task.status) || task.providerTaskId) return task;
  if (shouldDeferRelayProviderWorkToDedicatedWorker()) return task;
  if (parseJsonObject(task.providerPayload.resourceQueue).code !== "WORKSPACE_GENERATION_QUEUED"
    && Date.now() - Number(readRelayPortraitPreparation(task)?.readyAt || task.createTime || 0) > relayTaskStaleMs()) {
    return await failRelayTask(task, "任务排队超时，已释放冻结额度。");
  }
  if (!isAsyncVideoRelayProvider(task.provider) || !task.channelId || task.endpointType !== "video_generation") return task;
  const taskProvider = task.provider;

  const dispatchLeaseTask = await extendRelayTaskLease(task);
  if (!dispatchLeaseTask) return (await getRelayTask(task.id)) || task;
  task = dispatchLeaseTask;

  // Defense in depth for budget-bound rows created before the create-time
  // preflight existed (or whose persisted plan was corrupted). No provider
  // POST may occur for a plan that requires a second provider task.
  try {
    assertPrivateValidationBudgetSingleProviderTaskPlan(
      storedPrivateValidationBudget(task),
      restoreVideoResolutionPlanFromInternal(task.resultPayload, task.requestPayload),
    );
  } catch (error: any) {
    return await failRelayTask(
      task,
      error?.message || "私有验证预算拒绝多上游任务履约计划",
      {
        privateValidationBudgetGate: {
          state: "blocked_before_dispatch",
          code: String(error?.code || "private_validation_budget_multi_provider_task_forbidden"),
          providerRequestStarted: false,
          checkedAt: Date.now(),
        },
      },
    );
  }

  // A process can die after the monetary freeze commits but before the
  // request-quota reservation does. Every pre-POST worker path repairs (or
  // validates) that exact idempotent quota record before writing any dispatch
  // marker. Failure closes the task and releases the still-predispatch freeze.
  if (!hasVideoDispatchEvidence(task) && task.apiKeyId) {
    try {
      await reserveRelayTaskApiQuota(task);
      task = (await getRelayTask(task.id)) || task;
    } catch (error: any) {
      return await failRelayTask(
        task,
        error?.message || "视频 API Key 配额恢复失败，已停止上游派发",
        {
          apiQuotaGate: {
            state: "blocked_before_dispatch",
            providerRequestStarted: false,
            checkedAt: Date.now(),
          },
        },
      );
    }
  }

  // A persisted dispatch marker is the no-return boundary. If a process died
  // after this marker but before saving the provider task id, retrying the POST
  // could create a second paid generation. Leave the reservation for manual
  // reconciliation instead.
  if (hasVideoDispatchEvidence(task)) {
    const recoveryChannelRow = await db("o_provider_channel").where({ id: task.channelId }).first();
    const channel = recoveryChannelRow
      ? parseRelayChannel(recoveryChannelRow)
      : {
          id: String(task.channelId),
          name: "persisted-video-channel",
          provider: taskProvider,
          endpointType: "video_generation" as const,
          baseUrl: null,
          credentialRef: null,
          credentialCiphertext: null,
          config: {},
          timeoutMs: 0,
        };
    const submission = videoSubmission(task);
    const recoveredRejection = await recoverReleasedDefinitiveVideoRejection(task);
    if (recoveredRejection) return recoveredRejection;
    const persistedReconcileReason = String(submission.reconcileReason || "").trim();
    const reconcileReason = String(submission.state || "") === "pending_reconcile_persist_failed" && persistedReconcileReason
      ? persistedReconcileReason
      : "submit_recovery_without_provider_task_id";
    return await markVideoSubmissionUncertain({
      task,
      channel,
      reason: reconcileReason,
      message: "上游提交结果不确定，系统正在自动核实提交结果，请查询任务状态。",
      evidence: { recovery: true, attemptCount: task.attemptCount },
    });
  }

  try {
    const canonical = parseJsonObject(parseJsonObject(task.resultPayload.internal).canonicalVideoGeneration);
    if (parseJsonObject(canonical.request).operation === "edit") await assertMembershipFeature(String(task.workspaceId || ""), "rewrite");
    await assertMembershipFundingBeforeDispatch(db, String(parseJsonObject(task.providerPayload.billing).reservationId || "") || null);
  } catch (error: any) {
    return await failRelayTask(task, error?.message || "会员权益校验未通过，已释放预留额度");
  }
  let authorization: RelayPortraitDispatchAuthorization;
  try {
    authorization = await authorizePortraitRelayDispatch(task);
  } catch (error: any) {
    if (error instanceof WorkspaceGenerationQueued) {
      const id = String(parseJsonObject(task.providerPayload.billing).reservationId || "");
      if (id) await recordWorkspaceGenerationQueue(db, { workspaceId: String(task.workspaceId), id, endpointType: task.endpointType });
      await db("o_relay_task").where({ id: task.id, leaseOwner: task.leaseOwner })
        .whereNull("submittedAt").whereNull("providerTaskId").update({
          status: "queued", errorMessage: error.message, updateTime: Date.now(),
          providerPayload: stringifyJson({ ...task.providerPayload, resourceQueue: {
            code: error.code, queuedAt: Date.now(), current: error.current, limit: error.limit,
          } }),
          leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null,
        });
      return (await getRelayTask(task.id)) || task;
    }
    if (
      storedPrivateValidationBudget(task)
      && isPrivateValidationBudgetFailpoint(
        error,
        "after_task_dispatch_marker_before_billing",
      )
    ) {
      // Test-only hard-kill simulation. The authorization transaction has
      // rolled back both task and billing/budget dispatch markers.
      throw error;
    }
    const code = typeof error?.code === "string"
      ? error.code
      : "portrait_admission_recheck_failed";
    const policyFailure = code.startsWith("portrait_")
      || code.startsWith("video_")
      || code.startsWith("canonical_video_")
      || code.startsWith("seedance25_");
    return await failRelayTask(task, error?.message || (
      policyFailure ? "视频素材策略证据校验失败" : "视频供应商请求体无效"
    ), policyFailure
      ? {
          portraitAdmissionGate: {
            state: "blocked_before_dispatch",
            code,
            retryable: Boolean(error?.retryable),
            checkedAt: Date.now(),
          },
        }
      : {
        providerRequestValidation: {
          state: "rejected_predispatch",
          code,
          rejectedAt: Date.now(),
          retryAllowed: false,
        },
      });
  }
  if (authorization.kind === "fence_lost") {
    return authorization.task || (await getRelayTask(task.id)) || task;
  }
  if (authorization.kind === "channel_failure") {
    if (!authorization.portraitBound) {
      const failedOver = await tryVideoRecipeFailover(task, {
        outcome: "pre_dispatch_failure",
        message: authorization.message,
      });
      if (failedOver) return failedOver;
    }
    return await failRelayTask(task, authorization.message, {
      ...(authorization.credential ? { credential: authorization.credential } : {}),
      ...(authorization.portraitBound
        ? {
            portraitAdmissionGate: {
              state: "blocked_before_dispatch",
              code: "portrait_provider_channel_unavailable",
              retryable: true,
              checkedAt: Date.now(),
            },
          }
        : {}),
    });
  }

  task = authorization.task;
  const {
    channel,
    providerRequestPayload,
    formalCredentialRuntime,
    apiKey,
    baseUrl,
  } = authorization;
  if (!isAsyncVideoRelayProvider(channel.provider)) {
    return await failRelayTask(task, "视频生成运行时不支持当前供应商通道。");
  }
  const asyncProvider = channel.provider;
  const plan = restoreVideoResolutionPlanFromInternal(task.resultPayload, task.requestPayload);
  if (!storedPrivateValidationBudget(task)) {
    try {
      await markVideoBillingDispatched(task, channel);
    } catch (error: any) {
      return await markVideoSubmissionUncertain({
        task,
        channel,
        reason: "dispatch_marker_persistence_failed",
        message: error?.message || "视频计费 dispatch_started 持久化失败",
        providerRequestPayload,
      });
    }
  }
  const postDispatchLeaseTask = await extendRelayTaskLease(task);
  if (!postDispatchLeaseTask) return (await getRelayTask(task.id)) || task;
  task = postDispatchLeaseTask;

  let formalDispatchLease: FormalCandidateVideoDispatchLease | null = null;
  if (formalCredentialRuntime) {
    try {
      formalDispatchLease = acquireFormalCandidateVideoDispatchLease(
        {
          channelId: channel.id,
          provider: channel.provider,
          endpointType: "video_generation",
          model: String(task.model || "").trim(),
        },
        task.id,
        videoRelayProviderSubmitUrl(asyncProvider, baseUrl, task.model),
      );
    } catch {
      return await markVideoSubmissionUncertain({
        task,
        channel,
        reason: "formal_credential_lease_acquisition_failed",
        message: "正式候选运行时未能获得精确的一次性视频派发权限。",
        providerRequestPayload,
        evidence: { providerRequestStarted: false },
      });
    }
  }

  let providerPayload: Record<string, unknown> = {};
  let response: Response;
  try {
    if (formalDispatchLease) {
      const submission = await formalDispatchLease.submitJson(
        providerRequestPayload,
        resolveChannelTimeoutMs(channel),
      );
      response = submission.response;
      providerPayload = submission.payload;
    } else {
      const submission = await fetchProviderSubmissionWithFreshConnection({
        url: videoRelayProviderSubmitUrl(asyncProvider, baseUrl, task.model),
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: videoRelayProviderAuthorization(asyncProvider, apiKey),
          },
          body: JSON.stringify(providerRequestPayload),
        },
        timeoutMs: resolveChannelTimeoutMs(channel),
        consume: readJsonResponse,
      });
      response = submission.response;
      providerPayload = submission.value;
    }
  } catch (err: any) {
    const transportErrorCode = providerSubmissionTransportErrorCode(err);
    return await markVideoSubmissionUncertain({
      task,
      channel,
      reason: /timed out/i.test(String(err?.message || "")) ? "submit_timeout" : "submit_network_error",
      message: redactRelayText(err?.message || "Provider request failed"),
      providerRequestPayload,
      evidence: {
        errorClass: String(err?.name || "Error"),
        ...(transportErrorCode ? { errorCode: transportErrorCode } : {}),
        connectionMode: "fresh_non_pipelined_single_post",
      },
    });
  }

  if (!response.ok) {
    const message = getResponseErrorMessage(providerPayload, response.statusText || `HTTP ${response.status}`);
    if (isDefinitiveVideoRejection({ provider: channel.provider, httpStatus: response.status, response: providerPayload, providerTaskId: task.providerTaskId })) {
      // Persist the authoritative response before releasing money. Recovery only
      // retries the idempotent release; it never repeats the upstream POST.
      const query = db("o_relay_task").where({ id: task.id }).whereIn("status", ["queued", "running"]);
      if (task.leaseOwner) query.andWhere({ leaseOwner: task.leaseOwner });
      await query.update({ providerPayload: stringifyJson({
        ...(task.providerPayload || {}), request: providerRequestPayload, response: providerPayload,
        submission: { ...videoSubmission(task), state: "definitive_rejected", httpStatus: response.status, retryAllowed: false, rejectedAt: Date.now() },
      }), updateTime: Date.now() });
      const current = (await getRelayTask(task.id)) || task;
      const rejected = await recoverReleasedDefinitiveVideoRejection(current);
      if (rejected) return rejected;
    }
    // HTTP status alone is not authenticated provider evidence that a request
    // was non-billable. The dispatch marker already crossed the no-return
    // boundary, so every non-2xx result is reconciled without auto-failover or
    // auto-release.
    return await markVideoSubmissionUncertain({
      task,
      channel,
      reason: `submit_http_${response.status}`,
      message,
      providerRequestPayload,
      providerResponse: providerPayload,
      evidence: { httpStatus: response.status },
    });
  }

  const rawProviderTaskId = videoRelayProviderTaskId(asyncProvider, providerPayload);
  const providerTaskId = extractProviderTaskId({ id: rawProviderTaskId });
  if (!providerTaskId) {
    return await markVideoSubmissionUncertain({
      task,
      channel,
      reason: "submit_invalid_2xx",
      message: "供应商返回 2xx，但缺少合法任务 ID，系统正在自动核实。",
      providerRequestPayload,
      providerResponse: providerPayload,
      evidence: { httpStatus: response.status },
    });
  }
  if (formalDispatchLease) {
    try {
      formalDispatchLease.bindProviderTaskId(providerTaskId);
    } catch {
      return await markVideoSubmissionUncertain({
        task,
        channel,
        reason: "formal_credential_lease_task_binding_failed",
        message: "上游已受理，但正式候选视频权限无法绑定该任务，系统正在自动核实。",
        providerRequestPayload,
        providerResponse: providerPayload,
        evidence: { providerTaskIdObserved: true },
      });
    }
  }

  let status = normalizeKnownProviderStatus(
    videoRelayProviderStatus(asyncProvider, providerPayload),
  ) || "running";
  if (status === "queued") status = "running";
  let resultPayload: Record<string, unknown> = {
    ...providerPayload,
    internal: buildVideoInternalPlan(plan, task.resultPayload.internal),
  };
  let errorMessage: string | null = status === "failed" || status === "cancelled"
    ? getResponseErrorMessage(providerPayload, `供应商任务状态为 ${status}`)
    : null;
  const acceptedAt = Date.now();
  const acceptedAffected = await db("o_relay_task")
    .where({ id: task.id, status: "running", leaseOwner: task.leaseOwner || RELAY_WORKER_INSTANCE })
    .where("leaseExpiresAt", ">", acceptedAt)
    .whereNull("providerTaskId")
    .update({
      providerTaskId,
      providerPayload: stringifyJson({
        ...(task.providerPayload || {}),
        request: providerRequestPayload,
        response: providerPayload,
        submission: {
          ...videoSubmission(task),
          state: "accepted",
          acceptedAt,
          httpStatus: response.status,
          providerTaskId,
        },
      }),
      resultPayload: stringifyJson(resultPayload),
      errorMessage,
      updateTime: acceptedAt,
      heartbeatAt: acceptedAt,
    });
  if (Number(acceptedAffected || 0) !== 1) {
    const current = (await getRelayTask(task.id)) || task;
    try {
      await markVideoBillingPending(current, channel, "provider_task_id_persistence_race", {
        providerTaskId,
        httpStatus: response.status,
      });
    } catch (error) {
      if (isActiveStatus(current.status)) {
        return await keepVideoBillingRetryable(current, "provider_task_id_and_pending_persistence_race", error);
      }
      throw error;
    }
    await completeRelayTaskApiQuota(current, true).catch(() => undefined);
    return current;
  }

  let acceptedTask = (await getRelayTask(task.id)) || { ...task, providerTaskId };
  const extendedAcceptedTask = await extendRelayTaskLease(acceptedTask);
  if (!extendedAcceptedTask) return (await getRelayTask(task.id)) || acceptedTask;
  acceptedTask = extendedAcceptedTask;
  await completeRelayTaskApiQuota((await getRelayTask(task.id)) || acceptedTask, true).catch(() => undefined);

  const providerTerminalStatus = isTerminalStatus(status) ? status : null;
  let captured: boolean | "released" | null = null;
  // 路径 A failover:提交即返回终态失败/取消时,若本次冻结尚未扣费,
  // 自动切下一条候选配方。所有单位都延迟到可验证交付终态再 capture，
  // 避免目标档增强失败但源片降级时已经按目标 SKU 扣费。
  if (providerTerminalStatus && providerTerminalStatus !== "succeeded") {
    const failedOver = await tryVideoRecipeFailover(acceptedTask, {
      outcome: "provider_failed",
      message: errorMessage || `供应商任务状态为 ${providerTerminalStatus}`,
    });
    if (failedOver) return failedOver;
  }
  if (status === "succeeded" && isArkVideoTask(task) && !hasArkVideoResult(providerPayload)) {
    return await deferVideoPoll(acceptedTask, { reason: "upstream_result_url_missing", message: "上游任务已完成，正在获取视频链接" });
  }
  if (status === "succeeded" && !isArkVideoTask(task)) {
    try {
      const finalized = await finalizeSucceededGeneration({
        taskId: task.id,
        channelId: channel.id,
        generationAttemptId: providerTaskId,
        leaseOwner: String(acceptedTask.leaseOwner || task.leaseOwner || ""),
        workspaceId: task.workspaceId,
        requestId: task.requestId,
        prompt: videoPromptFromRequestPayload(task.requestPayload),
        model: task.model,
        payload: providerPayload,
        plan,
        persistedResultPayload: acceptedTask.resultPayload,
      });
      status = finalized.status;
      resultPayload = finalized.resultPayload;
      errorMessage = finalized.errorMessage;
    } catch (error) {
      if (error instanceof RelayEnhancementSubmissionHaltedError) {
        return (await getRelayTask(task.id)) || acceptedTask;
      }
      if (error instanceof RelayFinalizationFenceError) {
        return (await getRelayTask(task.id)) || acceptedTask;
      }
      return await deferVideoPoll(acceptedTask, {
        reason: "final_asset_persistence_failed",
        message: (error as any)?.message || "最终视频资产暂时无法安全入库",
      });
    }
  }

  if (providerTerminalStatus) {
    const billingLeaseTask = await extendRelayTaskLease(acceptedTask);
    if (!billingLeaseTask) return (await getRelayTask(task.id)) || acceptedTask;
    acceptedTask = billingLeaseTask;
    try {
      captured = await settleVideoBillingAfterDelivery({
        task: acceptedTask,
        channel,
        providerPayload,
        providerTerminalStatus,
        providerResponseOk: response.ok,
        deliveryStatus: status,
        resultPayload,
      });
    } catch (error: any) {
      try {
        await markVideoBillingPending(acceptedTask, channel, "video_terminal_settlement_failed", {
          providerTaskId,
          providerTerminalStatus,
          deliveryStatus: status,
          settlementError: redactRelayText(error?.message || error),
        });
        captured = false;
      } catch (pendingError) {
        return await keepVideoBillingRetryable(
          acceptedTask,
          "video_terminal_settlement_and_pending_persistence_failed",
          pendingError,
          {},
          resultPayload,
        );
      }
    }
  }

  const now = Date.now();
  const currentBeforeFinalUpdate = (await getRelayTask(task.id)) || acceptedTask;
  const finalAffected = await db("o_relay_task")
    .where({ id: task.id, status: "running", leaseOwner: task.leaseOwner || RELAY_WORKER_INSTANCE, providerTaskId })
    .where("leaseExpiresAt", ">", now)
    .update({
      status,
      providerPayload: stringifyJson({
        ...(currentBeforeFinalUpdate.providerPayload || {}),
        submission: {
          ...videoSubmission(currentBeforeFinalUpdate),
          state: captured === "released" ? "released" : captured
            ? "captured"
            : captured === false
              ? "pending_reconcile"
              : status === "enhancing"
                ? "awaiting_delivery"
                : "awaiting_terminal_usage",
          billingFinalizedAt: captured ? now : null,
        },
      }),
      resultPayload: stringifyJson(resultPayload),
      errorMessage,
      updateTime: now,
      completedAt: isTerminalStatus(status) ? now : null,
      ...releaseLeasePatch(),
    });
  let updatedTask = (await getRelayTask(task.id)) || acceptedTask;
  if (Number(finalAffected || 0) !== 1) return updatedTask;
  if (isTerminalStatus(updatedTask.status)) {
    updatedTask = await dispatchRelayCallbackIfNeeded(updatedTask);
    disposeFormalCandidateVideoDispatchLease(task.id);
  }
  return updatedTask;
}

async function finishPortraitPreparation(task: RelayTask, state: "failed" | "cancelled", code: string, message: string): Promise<RelayTask> {
  const marker = readRelayPortraitPreparation(task)!;
  // A crash can leave the freeze committed while the preparation marker is
  // still waiting. Release that exact reservation before publishing a terminal.
  if (await readVideoBillingReservation(task, false)) {
    await releaseVideoBilling(task, message);
    await completeRelayTaskApiQuota(task, false);
    task = (await getRelayTask(task.id)) || task;
  }
  const now = Date.now();
  const affected = await db("o_relay_task").where({ id: task.id, status: "queued", leaseOwner: task.leaseOwner })
    .where("leaseExpiresAt", ">", now).whereNull("providerTaskId").update({
      status: state, completedAt: now, updateTime: now, errorMessage: state === "failed" ? message : null,
      providerPayload: stringifyJson({ ...task.providerPayload, submission: {
        state: state === "failed" ? "portrait_preparation_failed" : "cancelled_before_dispatch",
      } }),
      resultPayload: stringifyJson({ ...task.resultPayload, internal: {
        ...parseJsonObject(task.resultPayload.internal),
        portraitPreparation: { ...marker, state, errorCode: code, errorMessage: message },
      } }), ...releaseLeasePatch(),
    });
  if (Number(affected) === 1) {
    await notifyAgentVideoGenerationTaskTerminal({ database: db, taskId: task.id,
      requestId: task.requestId, workspaceId: task.workspaceId, outcome: state,
      errorMessage: message, now }).catch(() => undefined);
  }
  const updated = (await getRelayTask(task.id)) || task;
  return Number(affected) === 1 ? await dispatchRelayCallbackIfNeeded(updated) : updated;
}

async function relayGenerationKeyPermission(task: RelayTask, trx: Knex.Transaction): Promise<"generation:create" | "relay:video_generation"> {
  const identity = parseJsonObject(task.providerPayload.identity);
  if (identity.generationKeyPermission === "generation:create") return "generation:create";
  if (identity.generationKeyPermission === "relay:video_generation") return "relay:video_generation";
  // Existing tool jobs predate this field. Recover the entrypoint from the
  // server-owned operation, never from a caller-controlled requestId prefix.
  const operation = task.apiKeyId ? await trx("o_external_tool_operation").where({
    relayTaskId: task.id, workspaceId: task.workspaceId, keyId: task.apiKeyId,
    userId: Number(identity.actorUserId || 0), projectId: task.projectId, kind: "fanjin_generation_submit",
  }).first("id") : null;
  return operation ? "generation:create" : "relay:video_generation";
}

async function assertRelayGenerationAuthorityInTransaction(
  task: RelayTask,
  trx: Knex.Transaction,
): Promise<void> {
  const identity = parseJsonObject(task.providerPayload.identity);
  const actorUserId = Number(identity.actorUserId || 0);
  if (!Number.isSafeInteger(actorUserId) || actorUserId < 1) {
    throw Object.assign(new Error("任务缺少可信提交者身份，请重新提交"), { code: "generation_actor_missing", status: 403 });
  }
  const workspaceId = String(task.workspaceId || "");
  const projectId = Number(task.projectId || 0);
  // 平台 Key 沿用 users -> 资金工作区 -> API Key 的锁顺序；先锁平台
  // 所有者和出资工作区，再进入通用工作区权限检查，避免反向等待。
  const keySnapshot = task.apiKeyId
    ? await trx("o_api_key").where({ id: task.apiKeyId }).first()
    : null;
  let platformOwner: any = null;
  if (keySnapshot?.scope === "platform") {
    const live = await lockLivePlatformApiKeyUsers({
      trx,
      actorUserId,
      ownerUserId: Number(keySnapshot.ownerUserId),
      requireOwnerAuthority: true,
    });
    platformOwner = live.owner;
    await lockLivePlatformApiKeyFundingAuthority({ trx, owner: platformOwner });
  }
  const actorAuthority = await requireLiveWorkspaceAuthority({
    database: trx,
    actorUserId,
    additionalUserIds: task.apiKeyId ? [actorUserId] : [],
    additionalMemberUserIds: task.apiKeyId ? [actorUserId] : [],
    authenticatedWorkspaceId: workspaceId,
    workspaceId,
    permission: "generation:create",
  });
  if (projectId > 0) {
    const projectAccess = await checkProjectPermission({
      database: trx,
      projectId,
      userId: actorUserId,
      role: actorAuthority.actor.role,
      authWorkspaceId: workspaceId,
      permission: "project:write",
      lock: true,
    });
    if (!projectAccess.allowed) {
      throw Object.assign(new Error("提交者当前无权写入该项目"), { code: "generation_project_write_revoked", status: 403 });
    }
  }
  if (!task.apiKeyId) return;
  const key = await trx("o_api_key").where({ id: task.apiKeyId }).forUpdate().first();
  const permissions = parseStoredRelayApiKeyPermissions(key?.permissions);
  const requiredKeyPermission = await relayGenerationKeyPermission(task, trx);
  let models: unknown = [];
  let modelsValid = true;
  try { models = key?.modelAllowlist == null ? [] : typeof key.modelAllowlist === "string" ? JSON.parse(key.modelAllowlist) : key.modelAllowlist; } catch { modelsValid = false; }
  if (!Array.isArray(models) || models.some((model) => typeof model !== "string")) modelsValid = false;
  if (!key || key.disabled || key.revokedAt
    || (Number(key.expiresAt) > 0 && Number(key.expiresAt) <= Date.now())
    || (key.scope === "workspace" && String(key.workspaceId) !== workspaceId)
    || !permissions?.includes(requiredKeyPermission)
    || !modelsValid || !Array.isArray(models) || (models.length > 0 && !modelAllowlistIncludes(models as string[], String(task.model)))
    || Number(key.ownerUserId) !== actorUserId) {
    throw Object.assign(new Error("提交凭据已失效或生成权限已撤销，请重新提交"), { code: "generation_authority_revoked", status: 403 });
  }
  if (key.scope === "workspace") {
    assertLiveWorkspaceApiKeyOwner(actorAuthority, actorUserId);
  }
}

type RelayCancellationContext = {
  actorUserId?: number | null;
  apiKey?: any;
  internal?: boolean;
};

async function assertRelayCancellationAuthorityInTransaction(
  task: RelayTask,
  trx: Knex.Transaction,
  context: RelayCancellationContext = {},
): Promise<void> {
  if (context.internal === true) return;
  const identity = parseJsonObject(task.providerPayload.identity);
  const actorUserId = Number(context.actorUserId || 0);
  if (!Number.isSafeInteger(actorUserId) || actorUserId < 1) {
    throw Object.assign(new Error("无法证明任务提交者身份"), { code: "cancel_actor_missing", status: 403 });
  }
  // 平台 Key 的锁顺序必须先完成用户和资金工作区锁，再锁 API Key。
  const keySnapshot = task.apiKeyId
    ? await trx("o_api_key").where({ id: task.apiKeyId }).first()
    : null;
  let platformOwner: any = null;
  if (keySnapshot?.scope === "platform") {
    const live = await lockLivePlatformApiKeyUsers({
      trx,
      actorUserId,
      ownerUserId: Number(keySnapshot.ownerUserId),
      requireOwnerAuthority: true,
    });
    platformOwner = live.owner;
    await lockLivePlatformApiKeyFundingAuthority({ trx, owner: platformOwner });
  }
  const authority = await requireLiveWorkspaceAuthority({
    database: trx,
    actorUserId,
    additionalUserIds: task.apiKeyId ? [actorUserId] : [],
    additionalMemberUserIds: task.apiKeyId ? [actorUserId] : [],
    authenticatedWorkspaceId: task.workspaceId,
    workspaceId: String(task.workspaceId || ""),
    permission: "generation:create",
  });
  const projectId = Number(task.projectId || 0);
  if (projectId > 0) {
    const projectAccess = await checkProjectPermission({
      database: trx,
      projectId,
      userId: actorUserId,
      role: authority.actor.role,
      authWorkspaceId: task.workspaceId,
      permission: "project:write",
      lock: true,
    });
    if (!projectAccess.allowed) {
      throw Object.assign(new Error("当前用户无权取消该项目任务"), { code: "cancel_project_write_revoked", status: 403 });
    }
  }
  const creatorUserId = Number(identity.actorUserId || 0);
  const role = String(authority.actor.role || "").toLowerCase();
  const isAdmin = ["owner", "workspace_admin", "root", "admin", "super_admin"].includes(role);
  if (!isAdmin && creatorUserId !== actorUserId) {
    throw Object.assign(new Error("只有任务提交者或工作区管理员可以取消任务"), { code: "cancel_creator_mismatch", status: 403 });
  }
  if (task.apiKeyId) {
    const key = await trx("o_api_key").where({ id: task.apiKeyId }).forUpdate().first();
    const apiKey = context.apiKey;
    const permissions = parseStoredRelayApiKeyPermissions(key?.permissions);
    const requiredKeyPermission = await relayGenerationKeyPermission(task, trx);
    let models: unknown = [];
    try { models = key?.modelAllowlist == null ? [] : typeof key.modelAllowlist === "string" ? JSON.parse(key.modelAllowlist) : key.modelAllowlist; } catch { models = null; }
    const keyMatches = Boolean(apiKey?.id && String(apiKey.id) === String(task.apiKeyId));
    if (!key || !keyMatches || key.disabled || key.revokedAt
      || (Number(key.expiresAt) > 0 && Number(key.expiresAt) <= Date.now())
      || (key.scope === "workspace" && String(key.workspaceId) !== String(task.workspaceId))
      || !permissions?.includes(requiredKeyPermission)
      || !Array.isArray(models) || models.some((model) => typeof model !== "string")
      || (models.length > 0 && !modelAllowlistIncludes(models as string[], String(task.model)))
      || Number(key.ownerUserId) !== actorUserId) {
      throw Object.assign(new Error("取消凭据已失效或范围不匹配"), { code: "cancel_authority_revoked", status: 403 });
    }
    if (key.scope === "workspace") {
      assertLiveWorkspaceApiKeyOwner(authority, actorUserId);
    }
  }
}

async function assertPortraitPreparationAuthority(task: RelayTask): Promise<void> {
  await assertRelayTaskProjectAuthority(task);
  await db.transaction(async (trx) => assertRelayGenerationAuthorityInTransaction(task, trx));
}

async function resumePortraitPreparation(original: RelayTask): Promise<RelayTask> {
  const checkpoint = readRelayPortraitPreparation(original)!;
  if (Date.now() < checkpoint.nextAttemptAt) return original;
  let task = await claimRelayTask(original);
  if (!task) return (await getRelayTask(original.id)) || original;
  try {
    if (Date.now() >= checkpoint.deadlineAt) {
      return await finishPortraitPreparation(task, "failed", "portrait_preparation_timeout", "参考素材登记超时，尚未提交生成，请检查素材登记结果后重试。");
    }
    await assertPortraitPreparationAuthority(task);
    const channelRow = await db("o_provider_channel").where({ id: task.channelId, disabled: 0 }).first();
    if (!channelRow) throw Object.assign(new Error("所选生成通道已停用，请重新选择模型"), { code: "portrait_provider_channel_unsupported", status: 409 });
    const channel = parseRelayChannel(channelRow);
    if (channel.provider !== task.provider || channel.endpointType !== task.endpointType
      || (channelRow.scope === "workspace" && channelRow.workspaceId !== task.workspaceId)
      || portraitChannelAccountSnapshot(channel).fingerprint !== checkpoint.accountFingerprint) {
      throw Object.assign(new Error("所选通道账号已变化，请重新提交以绑定当前通道"), { code: "portrait_provider_account_binding_stale", status: 409 });
    }
    const { canonicalRequest } = persistedVideoAssetPolicyCheckpoint(task);
    if (!canonicalRequest) throw Object.assign(new Error("参考素材登记任务缺少原始请求"), { status: 400 });
    await resolvePortraitProviderReferencesForChannel({
      workspaceId: String(task.workspaceId), projectId: String(task.projectId),
      assetVersionIds: canonicalRequest.inputs.map((item) => item.assetVersionId),
      providerChannelId: task.channelId, providerModel: task.model,
      prepareMissingBindings: true, requirePortraitRegistration: task.provider === "volcano",
    });
    const references = await resolveCanonicalGenerationReferences({
      workspaceId: String(task.workspaceId), projectId: String(task.projectId), references: canonicalRequest.inputs,
    });
    // Signed storage URLs can expire during registration. Refresh only the
    // reference URLs; preserve the original request for idempotent replay.
    let referenceIndex = 0;
    const content = Array.isArray(task.requestPayload.content) ? task.requestPayload.content : [];
    const preparedContent = content.map((item: any) => {
      if (!["image_url", "video_url", "audio_url"].includes(item?.type)) return item;
      const fresh = references.providerContent[referenceIndex++];
      if (!fresh || fresh.type !== item.type) throw Object.assign(new Error("素材引用顺序已变化，请重新提交"), { status: 409 });
      return { ...item, [item.type]: fresh[item.type] };
    });
    if (referenceIndex !== references.providerContent.length) throw Object.assign(new Error("素材引用数量与原请求不一致"), { status: 409 });
    const plan = restoreVideoResolutionPlanFromInternal(task.resultPayload, task.requestPayload);
    const identity = parseJsonObject(task.providerPayload.identity);
    const persistedActorUserId = Number(identity.actorUserId || 0);
    if (!Number.isSafeInteger(persistedActorUserId) || persistedActorUserId < 1) {
      throw Object.assign(new Error("旧任务缺少可信提交者身份，请重新提交"), {
        code: "generation_actor_missing",
        status: 403,
        retryable: false,
      });
    }
    const authorization = identity.billingAuthorization as RelayVideoBillingAuthorization | undefined;
    const relayInput: CreateRelayTaskInput = { endpointType: task.endpointType, model: task.model,
      provider: task.provider, apiKeyId: task.apiKeyId, workspaceId: task.workspaceId,
      projectId: task.projectId, requestId: task.requestId, principalId: identity.principalId as string,
      actorUserId: persistedActorUserId,
      requestPayload: task.requestPayload };
    const pricing = await resolveVideoPricingPlan(relayInput, channel, authorization ? undefined : canonicalRequest);
    if (pricing.costMicros > checkpoint.maximumCostMicros) {
      throw Object.assign(new Error("登记期间价格发生变化，超过本次确认上限，请重新确认价格"), { code: "generation_price_changed", status: 409 });
    }
    if (authorization) assertVideoBillingAuthorization({ authorization, pricingInput: relayInput, channel, pricing });
    const renewed = await extendRelayTaskLease(task);
    if (!renewed) return (await getRelayTask(task.id)) || task;
    task = renewed;
    if (!(await readVideoBillingReservation(task, false))) {
      await reserveVideoBilling(task.id, relayInput, channel, pricing, plan, authorization || null);
    }
    task = (await getRelayTask(task.id)) || task;
    await reserveRelayTaskApiQuota(task);
    task = (await getRelayTask(task.id)) || task;
    const now = Date.now();
    await db("o_relay_task").where({ id: task.id, status: "queued", leaseOwner: task.leaseOwner })
      .where("leaseExpiresAt", ">", now).whereNull("providerTaskId").update({
        providerPayload: stringifyJson({ ...task.providerPayload,
          preparedReferenceRequest: { ...task.requestPayload, content: preparedContent },
          submission: { state: "reserved" } }),
        resultPayload: stringifyJson({ ...task.resultPayload, internal: {
          ...parseJsonObject(task.resultPayload.internal), videoAssetPolicyEvidence: references.trustedPolicyEvidence,
          portraitPreparation: { ...checkpoint, state: "ready", readyAt: now, attempts: checkpoint.attempts + 1 },
        } }), updateTime: now, ...releaseLeasePatch(),
      });
    return (await getRelayTask(task.id)) || task;
  } catch (error: any) {
    const current = await getRelayTask(task.id);
    if (!current || current.leaseOwner !== task.leaseOwner
      || Number(current.leaseExpiresAt) <= Date.now() || !isRelayPortraitPreparing(current)) {
      return current || task;
    }
    task = current;
    const retryable = isPortraitPreparationPending(error)
      || (error?.retryable !== false && (Number(error?.status || error?.statusCode) >= 500
        || ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"].includes(error?.code)));
    if (!retryable) return await finishPortraitPreparation(task, "failed", String(error?.code || "portrait_preparation_failed"), redactRelayText(error?.message || "参考素材登记失败"));
    const now = Date.now();
    await db("o_relay_task").where({ id: task.id, status: "queued", leaseOwner: task.leaseOwner })
      .where("leaseExpiresAt", ">", now).update({ resultPayload: stringifyJson({
        ...task.resultPayload, internal: { ...parseJsonObject(task.resultPayload.internal), portraitPreparation: {
          ...checkpoint, attempts: checkpoint.attempts + 1, nextAttemptAt: now + 30_000,
          errorCode: String(error?.code || "portrait_registration_temporarily_unavailable"),
        } },
      }), updateTime: now, ...releaseLeasePatch() });
    return (await getRelayTask(task.id)) || task;
  }
}

/** Cancel only unsubmitted preparation; never call provider DELETE or erase a result. */
export async function cancelRelayPortraitPreparation(id: string, context: RelayCancellationContext = {}): Promise<{ task: RelayTask | null; cancelled: boolean }> {
  const current = await getRelayTask(id);
  if (!current || !isRelayPortraitPreparing(current) || hasVideoDispatchEvidence(current)) {
    return { task: current, cancelled: current?.status === "cancelled"
      && readRelayPortraitPreparation(current)?.state === "cancelled" && !hasVideoDispatchEvidence(current) };
  }
  await db.transaction(async (trx) => assertRelayCancellationAuthorityInTransaction(current, trx, context));
  const claimed = await claimRelayTask(current);
  if (!claimed) return { task: await getRelayTask(id), cancelled: false };
  const task = await finishPortraitPreparation(claimed, "cancelled", "portrait_preparation_cancelled", "已取消素材准备，未提交生成");
  return { task, cancelled: task.status === "cancelled" };
}

export async function refreshRelayTask(
  task: RelayTask,
  options: RefreshRelayTaskOptions = {},
): Promise<RelayTask> {
  const billingRecovery = parseJsonObject(task.providerPayload?.billingRecovery);
  const providerReadOnly = options.providerReadOnly === true
    || isRecoveryOnlyMode()
    || (billingRecovery.mode === "existing_provider_task"
      && Boolean(task.providerTaskId) && billingRecovery.providerTaskId === task.providerTaskId);
  if (isTerminalStatus(task.status)) return task;
  // Browser refreshes must not turn a failed delivery into repeated downloads
  // and object writes. Keep the same upstream task and retry after backoff.
  if (isVideoPersistenceRetryWaiting(task.providerPayload?.poll, Date.now())) return task;
  // This check precedes timeout handling and claim acquisition deliberately:
  // split API GET/admin refresh surfaces must be byte-for-byte provider and
  // lease neutral. The Worker will claim, submit and poll exactly once.
  if (shouldDeferRelayProviderWorkToDedicatedWorker()) return task;
  // A queued row without a durable upstream identity is not recoverable. In
  // recovery-only mode it must remain byte-for-byte billing neutral: no claim,
  // timeout release, failover, enhancement, or provider POST.
  if (
    providerReadOnly
    && recoveryOnlyRelayWorkDisposition(task).action === "skip"
  ) {
    return task;
  }
  if (!isAsyncVideoRelayProvider(task.provider)) {
    if (providerReadOnly) return task;
    return await recoverImmediateNonVolcanoVideoTask(task);
  }
  if (!task.channelId) return task;

  if (isRelayPortraitPreparing(task)) {
    if (providerReadOnly) return task;
    task = await resumePortraitPreparation(task);
    if (isRelayPortraitPreparing(task) || isTerminalStatus(task.status)) return task;
  }

  if (
    task.endpointType === "video_generation"
    && !task.providerTaskId
    && !hasVideoDispatchEvidence(task)
    && !(await readVideoBillingReservation(task, false))
  ) {
    // Task creation and monetary reservation are two durable commits. A Worker
    // must never cross the provider boundary in the gap. The exact Agent
    // idempotency owner can safely finish the same reservation; ordinary
    // callers remain queued until their creator commits it.
    return task;
  }

  // queued 任务以创建时间为基准；running 任务必须以提交上游的时间为基准。
  // 不能用 updateTime：worker 每次轮询都会刷新 updateTime，上游若永远返回"运行中"，任务将永不超时，冻结额度永不释放。
  const enhancementDispatchStartedAt = Number(
    videoEnhancementSubmission(task.resultPayload).dispatchStartedAt || 0,
  );
  const staleBaseTime =
    task.status === "queued"
      ? readRelayPortraitPreparation(task)?.readyAt || task.createTime
      : task.status === "enhancing" || enhancementDispatchStartedAt > 0
        ? Number(
            enhancementDispatchStartedAt
            || pickFirst(task.resultPayload, ["enhancement.startedAt"])
            || task.submittedAt
            || task.createTime,
          )
        : task.submittedAt || task.createTime;
  if (
    !providerReadOnly
    && !(task.status === "queued" && !hasVideoDispatchEvidence(task)
      && parseJsonObject(task.providerPayload.resourceQueue).code === "WORKSPACE_GENERATION_QUEUED")
    && Date.now() - Number(staleBaseTime || 0) > (isArkVideoTask(task)
      ? (Number(task.requestPayload.execution_expires_after) || 172800) * 1000 : relayTaskStaleMs())
  ) {
    const staleClaim = await claimRelayTask(task);
    if (!staleClaim) return (await getRelayTask(task.id)) || task;
    const dispatched = hasVideoDispatchEvidence(staleClaim);
    return await failRelayTask(
      staleClaim,
      task.status === "queued"
        ? "任务排队超时，已释放冻结额度。"
        : task.status === "enhancing"
          ? "高清处理超时；视频提交费用不自动退回。"
          : dispatched
            ? "任务执行超时；系统正在自动核实上游结果和费用。"
            : "任务执行超时，已释放冻结额度。",
    );
  }

  const claimedTask = await claimRelayTask(task);
  if (!claimedTask) return (await getRelayTask(task.id)) || task;
  task = claimedTask;

  if (task.endpointType === "video_generation") {
    const persistedPlan = restoreVideoResolutionPlanFromInternal(task.resultPayload, task.requestPayload);
    if (persistedPlan.invalidResolution) {
      if (providerReadOnly) {
        return await deferVideoPoll(task, {
          reason: "provider_read_only_invalid_persisted_resolution",
          message: "检查点中的视频分辨率无效，只读恢复不会据此终态化任务。",
        });
      }
      return await failRelayTask(task, "视频任务包含不支持的分辨率。");
    }
  }

  if (!task.providerTaskId && ["queued", "running"].includes(task.status)) {
    if (providerReadOnly) {
      return await deferVideoPoll(task, {
        reason: "provider_read_only_requires_existing_task",
        message: "只读恢复缺少既有供应商任务号，已禁止创建新任务。",
      });
    }
    return await submitRelayTaskToProvider(task);
  }

  if (task.providerTaskId && !providerReadOnly) {
    // Recover only API-key request quota here. Monetary reservation capture is
    // deliberately deferred until a verifiable delivery terminal below.
    await completeRelayTaskApiQuota(task, true).catch(() => undefined);
    task = (await getRelayTask(task.id)) || task;
  }

  const persistedEnhanceTaskId = pickFirst(task.resultPayload, [
    "enhancement.taskId",
    "enhancement.task_id",
  ]);
  const persistedEnhancementSubmissionState = String(
    videoEnhancementSubmission(task.resultPayload).state || "",
  );
  if (
    persistedEnhanceTaskId
    || persistedEnhancementSubmissionState === "synchronous_succeeded"
  ) {
    const extendedTask = await extendRelayTaskLease(task);
    if (!extendedTask) return (await getRelayTask(task.id)) || task;
    task = extendedTask;
    let next: Awaited<ReturnType<typeof pollVideoEnhancement>>;
    try {
      if (persistedEnhanceTaskId) {
        next = await pollVideoEnhancement(task);
      } else {
        const plan = restoreVideoResolutionPlanFromInternal(
          task.resultPayload,
          task.requestPayload,
        );
        const generationPayload = parseJsonObject(task.resultPayload.provider);
        const enhancementPayload = parseJsonObject(
          videoEnhancement(task.resultPayload).payload,
        );
        const sourceUrl = extractVideoUrl(generationPayload);
        if (!sourceUrl || !extractVideoUrl(enhancementPayload)) {
          return await markVideoEnhancementSubmissionUncertain({
            task,
            reason: "enhancement_synchronous_recovery_invalid",
            message: "已持久化的同步高清结果不完整，系统正在自动核实。",
            evidence: { recovery: true },
          });
        }
        next = await finalizeSynchronousVideoEnhancement({
          taskId: task.id,
          channelId: task.channelId || "",
          generationAttemptId: task.providerTaskId || task.id,
          leaseOwner: String(task.leaseOwner || ""),
          workspaceId: task.workspaceId,
          requestId: task.requestId,
          prompt: videoPromptFromRequestPayload(task.requestPayload),
          model: String(task.model || "").trim(),
          sourceUrl,
          plan,
          payload: generationPayload,
          enhancementPayload,
          persistedResultPayload: task.resultPayload,
        });
      }
    } catch (error) {
      if (error instanceof RelayEnhancementSubmissionHaltedError) {
        return (await getRelayTask(task.id)) || task;
      }
      if (error instanceof RelayFinalizationFenceError) {
        return (await getRelayTask(task.id)) || task;
      }
      return await deferVideoPoll(task, {
        reason: "enhancement_poll_or_asset_persistence_failed",
        message: (error as any)?.message || "高清结果暂时无法安全入库",
      });
    }
    // Retain an already produced enhancement even when its old billing record
    // cannot be settled. Viewing the result must not depend on repairing a freeze.
    if (isTerminalStatus(next.status)) {
      task = await persistVideoEnhancementResult(task, next.resultPayload);
    }
    let billingCaptured: boolean | "released" | null = null;
    const originalReservationComplete = isTerminalStatus(next.status)
      ? await hasCompleteVideoEnhancementReservation(task) : true;
    if (isTerminalStatus(next.status) && !originalReservationComplete) {
      billingCaptured = false;
    }
    if (isTerminalStatus(next.status) && originalReservationComplete) {
      const billingLeaseTask = await extendRelayTaskLease(task);
      if (!billingLeaseTask) return (await getRelayTask(task.id)) || task;
      task = billingLeaseTask;
      const billingChannelRow = task.channelId
        ? await db("o_provider_channel").where({ id: task.channelId }).first()
        : null;
      if (!billingChannelRow) {
        return await keepVideoBillingRetryable(
          task,
          "enhancement_terminal_billing_channel_missing",
          new Error("video billing channel missing"),
        );
      }
      const billingChannel = parseRelayChannel(billingChannelRow);
      const generationProviderPayload = parseJsonObject(task.resultPayload.provider);
      try {
        billingCaptured = await settleVideoBillingAfterDelivery({
          task,
          channel: billingChannel,
          providerPayload: generationProviderPayload,
          providerTerminalStatus: "succeeded",
          providerResponseOk: true,
          deliveryStatus: next.status,
          resultPayload: next.resultPayload,
        });
      } catch (error: any) {
        try {
          await markVideoBillingPending(task, billingChannel, "video_terminal_settlement_failed", {
            providerTaskId: task.providerTaskId,
            deliveryStatus: next.status,
            settlementError: redactRelayText(error?.message || error),
          });
          billingCaptured = false;
        } catch (pendingError) {
          if (await hasCompleteVideoEnhancementReservation(task)) {
            return await keepVideoBillingRetryable(
              task,
              "enhancement_terminal_billing_finalization_failed",
              pendingError,
            );
          }
          billingCaptured = false;
        }
      }
    }
    const now = Date.now();
    const affected = await db("o_relay_task")
      .where({ id: task.id, leaseOwner: task.leaseOwner || RELAY_WORKER_INSTANCE })
      .where("leaseExpiresAt", ">", now)
      .update({
        status: next.status,
        providerPayload: stringifyJson({
          ...(task.providerPayload || {}),
          submission: {
            ...videoSubmission(task),
            state: billingCaptured === "released" ? "released" : billingCaptured
              ? "captured"
              : billingCaptured === false
                ? "pending_reconcile"
                : "awaiting_delivery",
            billingFinalizedAt: billingCaptured ? now : null,
            ...(!originalReservationComplete ? {
              billingReconcileReason: "enhancement_terminal_reservation_unavailable",
              retryAllowed: false,
            } : {}),
          },
        }),
        resultPayload: stringifyJson(next.resultPayload),
        errorMessage: next.errorMessage,
        updateTime: now,
        completedAt: isTerminalStatus(next.status) ? now : null,
        ...releaseLeasePatch(),
    });
    if (Number(affected || 0) !== 1) return (await getRelayTask(task.id)) || task;
    let updatedTask = (await getRelayTask(task.id)) || task;
    if (isTerminalStatus(next.status)) {
      await completeRelayTaskApiQuota(updatedTask, true).catch(() => undefined);
      updatedTask = await dispatchRelayCallbackIfNeeded((await getRelayTask(task.id)) || updatedTask);
    }
    return updatedTask;
  }

  if (hasVideoEnhancementDispatchEvidence(task.resultPayload)) {
    try {
      return await markVideoEnhancementSubmissionUncertain({
        task,
        reason: String(
          videoEnhancementSubmission(task.resultPayload).reconcileReason
          || "enhancement_recovery_without_provider_task_id",
        ),
        message: "高清处理提交结果不确定，系统正在自动核实提交结果，请查询任务状态。",
        evidence: { recovery: true },
      });
    } catch (error) {
      if (error instanceof RelayFinalizationFenceError) {
        return (await getRelayTask(task.id)) || task;
      }
      return await deferVideoPoll(task, {
        reason: "enhancement_pending_reconcile_persistence_failed",
        message: (error as any)?.message || "高清处理待核账状态暂时无法持久化",
      });
    }
  }

  if (!task.providerTaskId) {
    await db("o_relay_task").where({ id: task.id, leaseOwner: task.leaseOwner || RELAY_WORKER_INSTANCE }).update({
      updateTime: Date.now(),
      ...releaseLeasePatch(),
    });
    return (await getRelayTask(task.id)) || task;
  }

  const channelRow = await db("o_provider_channel").where({ id: task.channelId }).first();
  if (!channelRow) {
    if (providerReadOnly) {
      return await deferVideoPoll(task, {
        reason: "provider_read_only_channel_missing",
        message: "恢复环境缺少检查点绑定的供应商通道，任务保持可恢复。",
      });
    }
    return await failRelayTask(task, "供应商通道不存在。");
  }
  const channel = parseRelayChannel(channelRow);
  if (channel.provider !== task.provider || channel.endpointType !== task.endpointType) {
    if (providerReadOnly) {
      return await deferVideoPoll(task, {
        reason: "provider_read_only_channel_identity_mismatch",
        message: "恢复环境供应商通道身份与检查点不一致，任务保持可恢复。",
      });
    }
    return await failRelayTask(task, "供应商通道身份与视频任务不匹配。");
  }
  if (!isAsyncVideoRelayProvider(channel.provider)) {
    return await failRelayTask(task, "视频生成运行时不支持当前供应商通道。");
  }
  const asyncProvider = channel.provider;

  const formalCredentialRuntime = channel.provider === "volcano"
    && isFormalCandidateCredentialRuntimeDeclared();
  const apiKey = formalCredentialRuntime ? "" : resolveProviderApiKey(channel);
  const baseUrl = resolveChannelBaseUrl(channel);
  if (!formalCredentialRuntime && !apiKey) {
    if (providerReadOnly) {
      return await deferVideoPoll(task, {
        reason: "provider_read_only_credential_missing",
        message: "恢复环境未提供供应商读取凭据，任务保持可恢复。",
      });
    }
    return await failRelayTask(task, "供应商凭据未配置", {
      credential: getProviderCredentialStatus(channel),
    });
  }
  if (!baseUrl) {
    if (providerReadOnly) {
      return await deferVideoPoll(task, {
        reason: "provider_read_only_base_url_missing",
        message: "恢复环境未提供供应商读取地址，任务保持可恢复。",
      });
    }
    return await failRelayTask(task, "供应商通道未配置 baseUrl。");
  }

  let response: Response;
  let payload: Record<string, unknown>;
  try {
    if (formalCredentialRuntime) {
      const formalDispatchLease = getFormalCandidateVideoDispatchLease(
        {
          channelId: channel.id,
          provider: channel.provider,
          endpointType: "video_generation",
          model: String(task.model || "").trim(),
        },
        task.id,
      );
      formalDispatchLease.bindProviderTaskId(task.providerTaskId);
      const result = await formalDispatchLease.pollJson(
        Number(channel.timeoutMs || 600000),
      );
      response = result.response;
      payload = result.payload;
    } else {
      response = await fetchWithTimeout(
        videoRelayProviderPollUrl(asyncProvider, baseUrl, task.providerTaskId),
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            Authorization: videoRelayProviderAuthorization(asyncProvider, apiKey),
          },
        },
        Number(channel.timeoutMs || 600000),
      );
      payload = await readJsonResponse(response);
    }
  } catch (error: any) {
    return await deferVideoPoll(task, {
      reason: /timed out/i.test(String(error?.message || "")) ? "poll_timeout" : "poll_network_error",
      message: error?.message || "Provider poll failed",
    });
  }

  if (!response.ok) {
    const message = getResponseErrorMessage(payload, response.statusText || `HTTP ${response.status}`);
    if (
      providerReadOnly
      || response.status >= 500
      || [408, 409, 425, 429, 499].includes(response.status)
    ) {
      return await deferVideoPoll(task, {
        reason: `${providerReadOnly ? "provider_read_only_" : ""}poll_http_${response.status}`,
        message,
        httpStatus: response.status,
        payload,
      });
    }
  }

  if ((asyncProvider === "autodl" || isArkVideoTask(task)) && response.ok
    && videoRelayProviderTaskId(asyncProvider, payload) !== task.providerTaskId) {
    return await deferVideoPoll(task, {
      reason: "poll_task_identity_mismatch",
      message: "供应商查询结果与当前任务不一致，稍后重新查询",
      httpStatus: response.status,
    });
  }
  const rawProviderStatus = videoRelayProviderStatus(asyncProvider, payload);
  const knownStatus = response.ok
    ? normalizeKnownProviderStatus(rawProviderStatus)
    : "failed";
  if (!knownStatus) {
    return await deferVideoPoll(task, {
      reason: "poll_invalid_2xx",
      message: "供应商轮询响应缺少合法任务状态",
      httpStatus: response.status,
      payload,
    });
  }

  const now = Date.now();
  const extendedTask = await extendRelayTaskLease(task);
  if (!extendedTask) return (await getRelayTask(task.id)) || task;
  task = extendedTask;
  let status: RelayTaskStatus = knownStatus;
  if (status === "queued") status = "running";
  const plan = restoreVideoResolutionPlanFromInternal(task.resultPayload, task.requestPayload);
  let resultPayload: Record<string, unknown> = {
    ...payload,
    internal: buildVideoInternalPlan(plan, task.resultPayload.internal),
  };
  let errorMessage = !response.ok ? getResponseErrorMessage(payload, response.statusText) : null;
  if (response.ok && (status === "failed" || status === "cancelled")) {
    const normalizedProviderStatus = String(rawProviderStatus || "").trim().toLowerCase();
    const fallback = normalizedProviderStatus === "expired"
      ? "供应商视频生成任务已过期"
      : normalizedProviderStatus === "timeout" || normalizedProviderStatus === "timed_out"
        ? "供应商视频生成任务超时"
        : `供应商任务状态为 ${normalizedProviderStatus || status}`;
    errorMessage = getResponseErrorMessage(payload, fallback);
  }

  const providerTerminalStatus = isTerminalStatus(status) ? status : null;
  let billingCaptured: boolean | "released" | null = null;
  // 路径 A failover:轮询发现供应商终态失败/取消时,若本次冻结尚未扣费
  // (如 token 计价),自动切下一条候选配方;已扣费的尝试不重试(不重复扣费边界)。
  if (providerTerminalStatus && providerTerminalStatus !== "succeeded") {
    if (!providerReadOnly) {
      const failedOver = await tryVideoRecipeFailover(task, {
        outcome: "provider_failed",
        message: errorMessage || `供应商任务状态为 ${providerTerminalStatus}`,
      });
      if (failedOver) return failedOver;
    }
  }

  if (status === "succeeded" && isArkVideoTask(task) && !hasArkVideoResult(payload)) {
    return await deferVideoPoll(task, { reason: "upstream_result_url_missing", message: "上游任务已完成，正在获取视频链接" });
  }
  if (status === "succeeded" && !isArkVideoTask(task)) {
    if (providerReadOnly && plan.needsEnhancement) {
      return await deferVideoPoll(task, {
        reason: "provider_read_only_enhancement_submission_blocked",
        message: "主视频已完成，但只读恢复禁止创建高清处理任务。",
        payload,
      });
    }
    try {
      const finalized = await finalizeSucceededGeneration({
        taskId: task.id,
        channelId: channel.id,
        generationAttemptId: task.providerTaskId || task.id,
        leaseOwner: String(task.leaseOwner || ""),
        workspaceId: task.workspaceId,
        requestId: task.requestId,
        prompt: videoPromptFromRequestPayload(task.requestPayload),
        model: task.model,
        payload,
        plan,
        persistedResultPayload: task.resultPayload,
      });
      status = finalized.status;
      resultPayload = finalized.resultPayload;
      errorMessage = finalized.errorMessage;
    } catch (error) {
      if (error instanceof RelayEnhancementSubmissionHaltedError) {
        return (await getRelayTask(task.id)) || task;
      }
      if (error instanceof RelayFinalizationFenceError) {
        return (await getRelayTask(task.id)) || task;
      }
      return await deferVideoPoll(task, {
        reason: "final_asset_persistence_failed",
        message: (error as any)?.message || "最终视频资产暂时无法安全入库",
      });
    }
  }

  if (providerTerminalStatus) {
    const billingLeaseTask = await extendRelayTaskLease(task);
    if (!billingLeaseTask) return (await getRelayTask(task.id)) || task;
    task = billingLeaseTask;
    try {
      billingCaptured = await settleVideoBillingAfterDelivery({
        task,
        channel,
        providerPayload: payload,
        providerTerminalStatus,
        providerResponseOk: response.ok,
        deliveryStatus: status,
        resultPayload,
      });
    } catch (error: any) {
      try {
        await markVideoBillingPending(task, channel, "video_terminal_settlement_failed", {
          providerTaskId: task.providerTaskId,
          providerTerminalStatus,
          deliveryStatus: status,
          settlementError: redactRelayText(error?.message || error),
        });
        billingCaptured = false;
      } catch (pendingError) {
        return await keepVideoBillingRetryable(
          task,
          "video_terminal_settlement_and_pending_persistence_failed",
          pendingError,
          {},
          resultPayload,
        );
      }
    }
  }

  const updateData: Record<string, unknown> = {
    status,
    providerPayload: stringifyJson({
      ...(task.providerPayload || {}),
      poll: null,
      response: payload,
      ...(providerTerminalStatus
        ? {
            submission: {
              ...videoSubmission(task),
              state: billingCaptured === "released" ? "released" : billingCaptured
                ? "captured"
                : billingCaptured === false
                  ? "pending_reconcile"
                  : status === "enhancing"
                    ? "awaiting_delivery"
                    : "awaiting_terminal_usage",
              billingFinalizedAt: billingCaptured ? now : null,
            },
          }
        : {}),
    }),
    resultPayload: stringifyJson(resultPayload),
    updateTime: now,
  };
  updateData.errorMessage = errorMessage;
  if (isTerminalStatus(status)) updateData.completedAt = now;
  Object.assign(updateData, releaseLeasePatch());

  const affected = await db("o_relay_task")
    .where({ id: task.id, leaseOwner: task.leaseOwner || RELAY_WORKER_INSTANCE })
    .where("leaseExpiresAt", ">", now)
    .update(updateData);
  if (Number(affected || 0) !== 1) return (await getRelayTask(task.id)) || task;
  let updatedTask = (await getRelayTask(task.id)) || task;
  if (isTerminalStatus(status)) {
    await completeRelayTaskApiQuota(updatedTask, true).catch(() => undefined);
    updatedTask = await dispatchRelayCallbackIfNeeded((await getRelayTask(task.id)) || updatedTask);
    disposeFormalCandidateVideoDispatchLease(task.id);
  }
  return updatedTask;
}

let relayWorkerTimer: ReturnType<typeof setInterval> | null = null;
let relayWorkerRunning = false;

export function startRelayTaskWorker() {
  if (relayWorkerTimer || process.env.FANJIN_DISABLE_RELAY_WORKER === "1") return;
  const intervalMs = Math.max(5000, Number(process.env.FANJIN_RELAY_WORKER_INTERVAL_MS || 30000));
  const batchSize = Math.max(1, Math.min(Number(process.env.FANJIN_RELAY_WORKER_BATCH_SIZE || 20), 100));

  const tick = async () => {
    if (relayWorkerRunning) return;
    relayWorkerRunning = true;
    try {
      const providerReadOnly = isRecoveryOnlyMode();
      const query = db("o_relay_task")
        .whereIn("status", ["queued", "running", "enhancing"])
        .where((builder) => {
          const timestamp = Date.now();
          builder.whereNull("leaseExpiresAt").orWhere("leaseExpiresAt", "<", timestamp);
        });
      // The recovered database may contain pre-submit queued work. Never let
      // that work cross the provider boundary after a restart.
      if (providerReadOnly) query.whereNotNull("providerTaskId");
      const rows = await query
        .orderBy("updateTime", "asc")
        .limit(batchSize);
      for (const row of rows) {
        try {
          await refreshRelayTask(parseRelayTask(row), { providerReadOnly });
        } catch (err) {
          console.warn("[relay-worker] refresh failed", row.id, (err as any)?.message || err);
        }
      }
    } finally {
      relayWorkerRunning = false;
    }
  };

  relayWorkerTimer = setInterval(() => {
    void tick();
  }, intervalMs);
  void tick();
}

export async function stopRelayTaskWorker(): Promise<void> {
  if (relayWorkerTimer) clearInterval(relayWorkerTimer);
  relayWorkerTimer = null;
  while (relayWorkerRunning) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function listRelayTasks(input: ListRelayTasksInput = {}): Promise<{ items: RelayTask[]; total: number; pageNum: number; pageSize: number }> {
  const pageNum = Math.max(1, Math.min(Number(input.pageNum || 1), 500));
  const pageSize = Math.max(1, Math.min(Number(input.pageSize || 20), 500));
  const baseQuery = db("o_relay_task");

  if (input.endpointType) baseQuery.where("endpointType", input.endpointType);
  if (input.model) baseQuery.where("model", internalModelId(input.model));
  if (input.serviceTier) {
    // Payloads are TEXT in both databases. Extract a scalar (Knex's generic
    // PostgreSQL jsonExtract uses a set-returning jsonb_path_query).
    baseQuery.whereRaw(isPostgresClient(db)
      ? "coalesce(??::jsonb ->> ?, ?) = ?"
      : "coalesce(json_extract(??, ?), ?) = ?",
    ["requestPayload", isPostgresClient(db) ? "service_tier" : "$.service_tier", "default", input.serviceTier]);
  }
  if (input.status) {
    const legacyStatus = (query: Knex.QueryBuilder) => {
      if (input.status === "succeeded") query.whereIn("status", relaySuccessFilterStatuses());
      else if (input.status === "running") query.whereIn("status", ["running", "enhancing"]);
      else query.where("status", input.status!);
    };
    if (!input.publicVideoStatus) legacyStatus(baseQuery);
    else {
      const jsonText = (column: string, path: string[]) => db.raw(isPostgresClient(db)
        ? "??::jsonb #>> ?" : "json_extract(??, ?)",
      [column, isPostgresClient(db) ? `{${path.join(",")}}` : `$.${path.join(".")}`]);
      const protocol = jsonText("resultPayload", ["internal", "arkVideoProtocol", "version"]);
      const upstream = jsonText("resultPayload", ["status"]);
      // Match the official DTO, not the internal billing/expiry status. Legacy
      // managed-video filtering keeps its delivery-proof semantics unchanged.
      const nativeStatus = db.raw(`case when ? in ('queued','running','succeeded','failed','cancelled','expired') then ?
        when ? like 'pending_reconcile%' and nullif(?, '') is not null then 'running'
        when ?? = 'enhancing' then 'running' else ?? end`, [upstream, upstream,
        jsonText("providerPayload", ["submission", "state"]),
        jsonText("providerPayload", ["submission", "reconcileReason"]), "status", "status"]);
      baseQuery.where(query => query.where(native => native.whereRaw("? = ?", [protocol, ARK_VIDEO_PROTOCOL_VERSION])
        .whereRaw("? = ?", [nativeStatus, input.status!]))
        .orWhere(legacy => legacy.whereRaw("coalesce(?, '') <> ?", [protocol, ARK_VIDEO_PROTOCOL_VERSION])
          .andWhere(legacyStatus)));
    }
  }
  if (input.workspaceId) baseQuery.where("workspaceId", input.workspaceId);
  if (input.apiKeyId) baseQuery.where("apiKeyId", input.apiKeyId);
  if (input.taskIds?.length) baseQuery.whereIn("id", input.taskIds);

  const countRow = await baseQuery.clone().count<{ total: number }[]>({ total: "*" }).first();
  const rows = await baseQuery
    .clone()
    .orderBy("createTime", "desc")
    .limit(pageSize)
    .offset((pageNum - 1) * pageSize);

  return {
    items: rows.map(parseRelayTask),
    total: Number((countRow as any)?.total || 0),
    pageNum,
    pageSize,
  };
}

async function cancelProviderTask(task: RelayTask): Promise<Record<string, unknown> | null> {
  if (!isAsyncVideoRelayProvider(task.provider) || !task.channelId || !task.providerTaskId) return null;
  const channelRow = await db("o_provider_channel").where({ id: task.channelId }).first();
  if (!channelRow) return null;
  const channel = parseRelayChannel(channelRow);
  if (!isAsyncVideoRelayProvider(channel.provider)) return null;
  const formalCredentialRuntime = channel.provider === "volcano"
    && isFormalCandidateCredentialRuntimeDeclared();
  const apiKey = formalCredentialRuntime ? "" : resolveProviderApiKey(channel);
  const baseUrl = resolveChannelBaseUrl(channel);
  if (!formalCredentialRuntime && !apiKey) {
    return { attempted: false, reason: "credential_not_configured" };
  }
  if (!baseUrl) return { attempted: false, reason: "base_url_not_configured" };
  const cancelUrl = videoRelayProviderCancelUrl(
    channel.provider,
    baseUrl,
    task.providerTaskId,
  );
  if (!cancelUrl) return { attempted: false, reason: "provider_cancel_unsupported" };

  try {
    let response: Response;
    let payload: Record<string, unknown>;
    if (formalCredentialRuntime) {
      const formalDispatchLease = getFormalCandidateVideoDispatchLease(
        {
          channelId: channel.id,
          provider: channel.provider,
          endpointType: "video_generation",
          model: String(task.model || "").trim(),
        },
        task.id,
      );
      formalDispatchLease.bindProviderTaskId(task.providerTaskId);
      const result = await formalDispatchLease.cancelJson(
        Number(channel.timeoutMs || 600000),
      );
      response = result.response;
      payload = result.payload;
    } else {
      response = await fetchWithTimeout(
        cancelUrl,
        {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
        },
        Number(channel.timeoutMs || 600000),
      );
      payload = await readJsonResponse(response);
    }
    return {
      attempted: true,
      ok: response.ok,
      status: response.status,
      payload,
    };
  } catch (err: any) {
    return {
      attempted: true,
      ok: false,
      error: err?.message || "cancel request failed",
    };
  }
}

export async function cancelOrDeleteRelayTask(id: string, context: RelayCancellationContext = {}): Promise<{ task: RelayTask | null; deleted: boolean; cancelled: boolean }> {
  const preparing = await getRelayTask(id);
  if (preparing && isRelayPortraitPreparing(preparing)) {
    return { ...await cancelRelayPortraitPreparation(id, context), deleted: false };
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const row = await db("o_relay_task").where({ id }).first();
    if (!row) return { task: null, deleted: false, cancelled: false };
    const task = parseRelayTask(row);
    if (task.status === "cancelled") return { task, deleted: false, cancelled: true };
    if (!isActiveStatus(task.status)) return { task, deleted: false, cancelled: false };
    await db.transaction(async (trx) => assertRelayCancellationAuthorityInTransaction(task, trx, context));

    if (task.endpointType === "video_generation") {
      // There is no independent, revision-fenced cancel-intent column in the
      // current schema. Reusing providerPayload/resultPayload would race a
      // live Worker write and could report a local cancellation while the
      // provider keeps running. Until a durable intent exists, the split API
      // must reject the command before claim, credentials, billing, or DELETE.
      if (shouldDeferRelayProviderWorkToDedicatedWorker()) {
        throw new RelayWorkerCancellationRequiredError();
      }
      // Cancellation does not steal a live worker lease. If a worker is at the
      // dispatch boundary, its exact lease must finish/expire first; otherwise
      // a cancellation CAS could return success while that worker still POSTs.
      const claimedTask = await claimRelayTask(task);
      if (!claimedTask) {
        const current = await getRelayTask(id);
        return { task: current, deleted: false, cancelled: current?.status === "cancelled" };
      }
      let cancellationTask = await extendRelayTaskLease(claimedTask);
      if (!cancellationTask) {
        const current = await getRelayTask(id);
        return { task: current, deleted: false, cancelled: current?.status === "cancelled" };
      }
      const dispatched = hasVideoDispatchEvidence(cancellationTask);
      const channelRow = cancellationTask.channelId
        ? await db("o_provider_channel").where({ id: cancellationTask.channelId }).first()
        : null;
      const billingChannel = channelRow
        ? parseRelayChannel(channelRow)
        : cancellationTask.channelId && cancellationTask.provider
          ? {
              id: cancellationTask.channelId,
              name: "persisted-video-channel",
              provider: cancellationTask.provider,
              endpointType: "video_generation" as const,
              baseUrl: null,
              credentialRef: null,
              config: {},
              timeoutMs: 0,
            }
          : null;
      const keepCancellationRetryable = async (
        reason: string,
        error?: unknown,
      ): Promise<{ task: RelayTask | null; deleted: boolean; cancelled: boolean }> => {
        const timestamp = Date.now();
        const current = (await getRelayTask(id)) || cancellationTask!;
        const retryQuery = db("o_relay_task")
          .where({ id, leaseOwner: cancellationTask!.leaseOwner })
          .whereIn("status", ["queued", "running", "enhancing"]);
        await retryQuery.update({
          providerPayload: stringifyJson({
            ...(current.providerPayload || {}),
            submission: {
              ...videoSubmission(current),
              state: "pending_reconcile_persist_failed",
              reconcileReason: reason,
              pendingPersistenceError: error
                ? redactRelayText((error as any)?.message || error)
                : null,
              retryAllowed: false,
            },
          }),
          updateTime: timestamp,
          completedAt: null,
          ...releaseLeasePatch(),
        });
        return { task: await getRelayTask(id), deleted: false, cancelled: false };
      };

      let billingReconcileReason: string | null = null;
      if (!dispatched) {
        const reservation = await db("o_billing_ledger")
          .where({ type: "freeze", relatedTaskId: cancellationTask.id })
          .orderBy("createdAt", "desc")
          .first();
        try {
          if (reservation) {
            await releaseVideoBilling(cancellationTask, "视频任务在调用上游前取消");
          }
        } catch (releaseError: any) {
          if (!billingChannel) {
            return await keepCancellationRetryable(
              "cancel_before_dispatch_release_failed",
              releaseError,
            );
          }
          try {
            await markVideoBillingPending(cancellationTask, billingChannel, "cancel_before_dispatch_release_failed", {
              providerDispatchConfirmed: false,
              releaseError: redactRelayText(releaseError?.message || releaseError),
            });
            billingReconcileReason = "cancel_before_dispatch_release_failed";
          } catch (pendingError) {
            return await keepCancellationRetryable(
              "cancel_before_dispatch_release_and_pending_persistence_failed",
              pendingError,
            );
          }
        }
      } else {
        if (!billingChannel) {
          return await keepCancellationRetryable(
            "cancel_after_dispatch_billing_channel_missing",
          );
        }
        billingReconcileReason = cancellationTask.providerTaskId
          ? "cancel_after_dispatch_without_qualified_delivery"
          : "cancel_after_dispatch_without_provider_task_id";
        try {
          await markVideoBillingPending(
            cancellationTask,
            billingChannel,
            billingReconcileReason,
            {
              providerTaskId: cancellationTask.providerTaskId,
              customerBillingPolicy: "target_sku_all_or_nothing",
            },
          );
        } catch (pendingError) {
          return await keepCancellationRetryable(
            "cancel_after_dispatch_pending_persistence_failed",
            pendingError,
          );
        }
      }

      let providerCancel: Record<string, unknown> | null = null;
      if (dispatched) {
        const providerCancelLease = await extendRelayTaskLease(cancellationTask);
        if (!providerCancelLease) {
          const current = await getRelayTask(id);
          return { task: current, deleted: false, cancelled: current?.status === "cancelled" };
        }
        cancellationTask = providerCancelLease;
        providerCancel = await cancelProviderTask(cancellationTask);
      }

      const terminalAt = Date.now();
      const latest = (await getRelayTask(id)) || cancellationTask;
      const cancelled = await db("o_relay_task")
        .where({
          id,
          status: cancellationTask.status,
          leaseOwner: cancellationTask.leaseOwner,
        })
        .where("leaseExpiresAt", ">", terminalAt)
        .update({
          status: "cancelled",
          providerPayload: stringifyJson({
            ...(latest.providerPayload || {}),
            submission: {
              ...videoSubmission(latest),
              state: billingReconcileReason
                ? "pending_reconcile"
                : "cancelled_before_dispatch",
              ...(billingReconcileReason
                ? { reconcileReason: billingReconcileReason }
                : {}),
              retryAllowed: false,
            },
            cancellation: {
              requestedAt: terminalAt,
              afterDispatch: dispatched,
              providerTaskId: cancellationTask.providerTaskId,
              provider: providerCancel,
              completedAt: terminalAt,
            },
          }),
          updateTime: terminalAt,
          completedAt: terminalAt,
          ...releaseLeasePatch(),
        });
      if (Number(cancelled || 0) !== 1) {
        const current = await getRelayTask(id);
        return { task: current, deleted: false, cancelled: current?.status === "cancelled" };
      }
      let cancelledTask = (await getRelayTask(id)) || cancellationTask;
      await completeRelayTaskApiQuota(cancelledTask, dispatched).catch(() => undefined);
      cancelledTask = (await getRelayTask(id)) || cancelledTask;
      disposeFormalCandidateVideoDispatchLease(id);
      // Agent 异步任务接力：取消也是终态，必须唤醒 waiting_external
      // executor Run；通知失败不改变已提交的取消终态，兜底清扫会恢复。
      await notifyAgentVideoGenerationTaskTerminal({
        database: db,
        taskId: cancelledTask.id,
        requestId: cancelledTask.requestId,
        workspaceId: cancelledTask.workspaceId,
        outcome: "cancelled",
        errorMessage: null,
        now: Date.now(),
      }).catch(() => undefined);
      return {
        task: await dispatchRelayCallbackIfNeeded(cancelledTask),
        deleted: false,
        cancelled: true,
      };
    }

    const now = Date.now();
    const affected = await db("o_relay_task")
      .where({ id, status: task.status, providerPayload: row.providerPayload })
      .update({
        status: "cancelled",
        updateTime: now,
        completedAt: now,
        ...releaseLeasePatch(),
      });
    if (Number(affected || 0) !== 1) continue;
    await completeRelayBilling(id, "cancelled");
    await completeApiKeyQuota(task.apiKeyId, id, false);
    const cancelledTask = (await getRelayTask(id)) || task;
    return {
      task: await dispatchRelayCallbackIfNeeded(cancelledTask),
      deleted: false,
      cancelled: true,
    };
  }
  const current = await getRelayTask(id);
  return { task: current, deleted: false, cancelled: current?.status === "cancelled" };
}

export function canAccessRelayTask(task: RelayTask, context: { apiKey?: any; auth?: any } = {}): boolean {
  const apiKey = context.apiKey;
  // API Keys are scoped to their exact persisted task identity. A workspace
  // match alone is insufficient because projects may be private.
  return Boolean(apiKey?.id && task.apiKeyId && String(task.apiKeyId) === String(apiKey.id));
}

export async function formatPublicRelayTask(
  task: RelayTask,
  runtime = process.env.NODE_ENV,
): Promise<Record<string, unknown>> {
  if (isArkVideoTask(task)) return formatArkVideoTask(task);
  const syntheticQuarantined = shouldQuarantineRelayArtifacts(
    task.status,
    runtime,
  );
  const persistedAssets = await db("o_media_asset")
    .where({
      taskId: task.id,
      workspaceId: task.workspaceId,
      projectId: task.projectId,
    })
    .orderBy("createTime", "asc");
  const assets = syntheticQuarantined ? [] : persistedAssets;
  const plan = !syntheticQuarantined && task.endpointType === "video_generation"
    ? restoreVideoResolutionPlanFromInternal(task.resultPayload, task.requestPayload)
    : null;
  const progress = syntheticQuarantined
    ? {
        status: "failed",
        stage: "failed",
        stageLabel: "失败",
        progress: 0,
        progressPercent: 0,
        targetResolution: null,
        needsTargetProcessing: false,
      }
    : getRelayTaskProgress(task);
  const finalVideo =
    assets.find((asset: any) => asset.source === "relay_final" && asset.assetType === "video") ||
    assets.find((asset: any) => asset.assetType === "video");
  const deliveryPublication = plan
    ? publishRelayVideoDelivery(task, assets)
    : null;
  const deliveryPublic = deliveryPublication
    ? publicDeliveryPart(deliveryPublication)
    : {};
  const projectedVideoUrl =
    typeof deliveryPublic.video_url === "string"
      ? deliveryPublic.video_url
      : null;
  const videoUrl = syntheticQuarantined
    ? null
    : plan
      ? projectedVideoUrl
      : finalVideo?.url || pickFirst(task.resultPayload, ["public.video_url", "content.video_url", "video_url"]);
  const outputAssets = plan
    ? (finalVideo && projectedVideoUrl ? [{ ...finalVideo, url: projectedVideoUrl }] : [])
    : assets;
  const output = outputAssets.map((asset: any) => {
    const projectAssetLink = readVideoAssetLink(asset.metadata);
    return {
      type: asset.assetType,
      url: asset.url,
      mime_type: asset.mimeType ?? undefined,
      width: asset.width ?? undefined,
      height: asset.height ?? undefined,
      duration_ms: asset.durationMs ?? undefined,
      media_asset_id: asset.id,
      asset_id: projectAssetLink?.assetId,
      asset_version_id: projectAssetLink?.assetVersionId,
    };
  });
  const deliveryProjection = deliveryPublication?.projection ?? null;
  const deliveryFailure = deliveryProjection?.failure ?? null;
  const projectedProgress = isRelayPortraitPreparing(task)
    ? { stage: "queued", stageLabel: "素材登记中", progress: 0 }
    : deliveryProjection
    ? deliveryProjection.taskStatus === "succeeded"
      ? { stage: "completed", stageLabel: "已完成", progress: 100 }
      : deliveryProjection.taskStatus === "failed"
        ? { stage: "failed", stageLabel: "失败", progress: progress.progress }
        : deliveryProjection.taskStatus === "cancelled"
          ? { stage: "cancelled", stageLabel: "已取消", progress: progress.progress }
          : deliveryProjection.taskStatus === "queued"
            ? { stage: "queued", stageLabel: "排队中", progress: progress.progress }
            : deliveryProjection.taskStatus === "pending_reconcile"
              ? { stage: "processing", stageLabel: "正在同步结果", progress: Math.min(progress.progress, 99) }
              : deliveryProjection.phase === "enhancing"
                ? { stage: "processing", stageLabel: "高清处理中", progress: progress.progress }
                : { stage: "generating", stageLabel: "视频生成中", progress: progress.progress }
    : progress;
  const callbackState = task.providerPayload.callback && typeof task.providerPayload.callback === "object"
    ? task.providerPayload.callback as Record<string, unknown>
    : null;
  const candidateStatus = syntheticQuarantined
    ? "failed"
    : deliveryProjection?.taskStatus ?? progress.status;
  const status: PublicVideoTaskStatus = PUBLIC_VIDEO_TASK_STATUSES.includes(
    candidateStatus as PublicVideoTaskStatus,
  )
    ? candidateStatus as PublicVideoTaskStatus
    : "failed";

  return {
    id: task.id,
    ...relayPortraitPreparationView(task),
    object: PUBLIC_VIDEO_TASK_OBJECT,
    draft: draftTaskInfo(task),
    model: publicModelId(task.endpointType === "video_generation"
      ? String(task.requestPayload.model || task.model || "") || null
      : task.model),
    // `pending_reconcile` is deliberately frozen in v0.0.7 as a public,
    // non-terminal wire status. Callers must poll instead of resubmitting an
    // operation whose provider outcome or local settlement is still unknown.
    status,
    billing_state: task.endpointType === "video_generation"
      ? publicVideoBillingState(task)
      : undefined,
    stage: projectedProgress.stage,
    stage_label: projectedProgress.stageLabel,
    progress: projectedProgress.progress,
    progress_percent: projectedProgress.progress,
    created_at: toUnixSeconds(task.createTime),
    updated_at: toUnixSeconds(task.updateTime),
    completed_at: toUnixSeconds(task.completedAt),
    resolution: plan?.requestedResolution ?? undefined,
    delivery: plan ? deliveryPublic.delivery ?? null : undefined,
    met_requested_quality: plan
      ? deliveryPublic.metRequestedQuality ?? false
      : undefined,
    content: videoUrl
      ? {
          video_url: videoUrl,
        }
      : undefined,
    error: syntheticQuarantined
      ? {
          code: "synthetic_result_quarantined",
          message: RELAY_SYNTHETIC_QUARANTINE_MESSAGE,
        }
      : parseJsonObject(task.providerPayload?.customerSettlement).contractVersion === VIDEO_RESERVATION_EXPIRY_POLICY
        && videoSubmission(task).state === "released"
      ? { code: "VIDEO_RESERVATION_AUTO_RELEASED", message: VIDEO_RESERVATION_EXPIRED_MESSAGE }
      : readRelayPortraitPreparation(task)?.state === "failed"
      ? { code: readRelayPortraitPreparation(task)?.errorCode, message: task.errorMessage }
      : plan
      ? deliveryFailure
        ? {
            code: publicH3Text(deliveryFailure.code),
            message: publicH3Text(deliveryFailure.safeMessage),
          }
        : null
      : task.errorMessage
        ? {
            message: publicH3Text(redactRelayText(task.errorMessage)),
          }
        : null,
    output,
    synthetic_quarantine: syntheticQuarantined
      ? {
          active: true,
          reason: RELAY_SYNTHETIC_QUARANTINE_MESSAGE,
        }
      : undefined,
    callback: callbackState
      ? {
          id: callbackState.deliveryId ?? null,
          status: callbackState.status ?? null,
          attempts: Number(callbackState.attempts || 0),
          next_attempt_at: callbackState.nextAttemptAt ?? null,
          delivered_at: callbackState.deliveredAt ?? null,
          last_http_status: callbackState.httpStatus ?? null,
        }
      : undefined,
  };
}
