import crypto from "node:crypto";
import { quickCreateImagePendingReconcileBody } from "@/lib/quickCreateImageFailure";
import { redactSensitiveText } from "@/lib/redactSensitiveText";
import { WorkspaceGenerationQueued } from "@/lib/workspaceResources";
import path from "node:path";

import express from "express";
import type { Knex } from "knex";
import { z } from "zod";
import {
  executeRelayImage,
  RelayImageError,
  shouldRetryIdempotentImageRequest,
  type RelayImageResult,
} from "@/lib/relayImage";
import { resolveRelayWorkspaceId } from "@/lib/relayUtils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";
import { requireProjectPermission } from "@/middleware/projectAccess";
import { db } from "@/utils/db";
import {
  BillingError,
  calculatePricingCost,
  publicBillingErrorDetails,
  resolveProviderSpecificPricingRule,
} from "@/lib/billing";
import { resolveWorkbenchModelCapability } from "@/lib/workbenchModelCatalog";
import {
  persistGeneratedProjectImages,
  type PersistedGeneratedImage,
  type PersistedGeneratedWorkspaceImage,
} from "@/lib/generatedImagePersistence";
import { ensureInspirationWorkspaceProject } from "@/lib/inspirationWorkspaceProject";
import {
  abandonDurableCommand,
  beginDurableCommand,
  checkpointDurableCommand,
  completeDurableCommand,
  mutateDurableCommandCheckpoint,
  type DurableCommandReservation,
  DurableCommandIdempotencyError,
  TRUSTED_GENERATED_IMAGE_COMMAND_RETENTION_MS,
} from "@/lib/durableCommandIdempotency";
import {
  GenerationReferenceError,
  GENERATION_REFERENCE_ROLES,
  inspectGenerationReferences,
  resolveGenerationReferences,
  type GenerationReference,
} from "@/lib/generationReferenceResolver";
import {
  beginProjectImageTask,
  canRetryProjectImageProvider503,
  checkpointProjectImageProviderSuccess,
  claimProjectImageTask,
  completeProjectImageTask,
  failProjectImageTask,
  ProjectImageTaskError,
  projectImageTaskCancelHandlers,
  projectImageTaskStatusHandlers,
  requeueProjectImageTask,
  type ProjectImageTaskReservation,
} from "@/lib/projectImageTask";
import {
  isRetryablePortraitProviderBindingPending,
  isUnsupportedPortraitImageReference,
  portraitProviderBindingRetrySchedule,
  PORTRAIT_PROVIDER_BINDING_PENDING_CODE,
} from "@/lib/portraitProviderBindingRetry";
import { readRequiredIdempotencyKey } from "@/middleware/idempotencyKey";
import { hashIdempotencyRequest } from "@/agent-runtime/idempotency";
import { resolveVolcengineImageSize } from "@/lib/volcengineImageSize";
import type { RelayUnitBillingCheckpoint } from "@/lib/relayBillingSession";
import {
  issueQuickCreatePricingConfirmation,
  quickCreatePricingChallengeBody,
  QuickCreatePricingConfirmationError,
  QuickCreatePricingTokenError,
  verifyQuickCreatePricingConfirmation,
  type QuickCreatePricingAuthorization,
  type QuickCreatePricingConfirmationBinding,
} from "@/lib/quickCreatePricingConfirmation";
import {
  QUICK_CREATE_IMAGE_CHECKPOINT_MATERIALIZE_HEADER,
  quickCreateImageCheckpointRecoveryAuthorizedValue,
  quickCreateImageCheckpointMaterializeOnly,
} from "@/lib/quickCreateImageCheckpointMaterialization";
import {
  CANDIDATE_E_IMAGE_RECOVERY_AUTHORIZATION_HEADER,
  CANDIDATE_E_IMAGE_RECOVERY_PROOF_HEADER,
  CandidateESettledImageRecoveryError,
  activateCandidateESettledImageRecoveryCapability,
  authorizeCandidateESettledImageRecoveryRequest,
  candidateESettledImageRecoveryCapabilityBound,
  candidateERecoverySha256,
  candidateERecoveryStableJson,
  commitCandidateESettledImageRecoveryCapability,
  finalizeCandidateESettledImageRecoveryExecution,
  type CandidateERecoveryMaterializationProof,
  type CandidateERecoveryTicket,
} from "@/lib/candidateESettledImageRecovery";
import {
  CANDIDATE_E_SETTLED_IMAGE_ACK_HEADER,
  CANDIDATE_E_SETTLED_IMAGE_ARMING_HEADER,
  CANDIDATE_E_SETTLED_IMAGE_FAILPOINT_HEADER,
  CANDIDATE_E_SETTLED_IMAGE_QUOTE_HEADER,
  CANDIDATE_E_SETTLED_IMAGE_QUOTE_VALUE,
  CANDIDATE_E_SETTLED_IMAGE_QUOTE_VERSION,
  CANDIDATE_E_SETTLED_IMAGE_QUOTE_LIFETIME_MS,
  CANDIDATE_E_SETTLED_IMAGE_ACK_VALUE,
  CandidateESettledImageFailpointError,
  CandidateESettledImageInjectedFailure,
  acquireCandidateESettledImageOperationClaim,
  assertCandidateESettledImageDispatchAndAcquireGuard,
  authorizeCandidateESettledImageFailpoint,
  candidateEQuoteDigest,
  candidateERouteDigest,
  candidateESha256,
  releaseCandidateESettledImageOperationClaimIfSafe,
  triggerCandidateESettledImageFailpoint,
  type CandidateEOperationClaim,
  type CandidateESettledImageAuthorization,
  type CandidateESettledImageCommandIdentity,
} from "@/lib/candidateESettledImageFailpoint";
import {
  selectChannelCandidates,
  selectPreferredModelRouteScope,
} from "@/lib/channelRouter";
import {
  formalCandidateRuntimeSurfaceForRequest,
  type FormalCandidateRuntimeSurfaceContext,
} from "@/lib/candidateRuntimeAttestation";
import type {
  CandidateExactAuthorizationRuntimeSession,
} from "@/lib/candidateExactAuthorizationCanonical";
import {
  CANDIDATE_EXACT_AUTHORIZATION_BASE_LAUNCHER_TRUST_STORE_ENV,
  CANDIDATE_EXACT_AUTHORIZATION_FORMAL_LAUNCHER_TRUST_STORE_ENV,
} from "@/lib/candidateExactAuthorizationTrust";
import {
  RELEASE_ARTIFACT_TRUSTED_PUBLIC_KEYS_ENV,
} from "@/lib/releaseArtifactAttestation";

const router = express.Router();

const SUBMITTABLE_CAPABILITY_STATUSES = new Set(["verified", "configured", "legacy"]);
const MAX_QUICK_CREATE_IMAGE_REFERENCES = 16;
const CANDIDATE_E_FORMAL_RECOVERY_AUTHORIZED = Symbol(
  "candidate-e-formal-recovery-authorized",
);
const CANDIDATE_E_RECOVERY_REQUEST_HEADERS = Object.freeze([
  QUICK_CREATE_IMAGE_CHECKPOINT_MATERIALIZE_HEADER,
  CANDIDATE_E_IMAGE_RECOVERY_AUTHORIZATION_HEADER,
  CANDIDATE_E_IMAGE_RECOVERY_PROOF_HEADER,
]);
const CANDIDATE_E_REQUEST_HEADERS = Object.freeze([
  CANDIDATE_E_SETTLED_IMAGE_FAILPOINT_HEADER,
  CANDIDATE_E_SETTLED_IMAGE_ARMING_HEADER,
  CANDIDATE_E_SETTLED_IMAGE_ACK_HEADER,
  CANDIDATE_E_SETTLED_IMAGE_QUOTE_HEADER,
  ...CANDIDATE_E_RECOVERY_REQUEST_HEADERS,
]);

function sendCandidateENotFound(response: express.Response) {
  return response.status(404).send({ code: "NOT_FOUND" });
}

type CandidateESurfaceLocals = {
  candidateEFormalRuntimeSurface?: FormalCandidateRuntimeSurfaceContext;
  [CANDIDATE_E_FORMAL_RECOVERY_AUTHORIZED]?: true;
};

type CandidateESurfaceGateDependencies = Readonly<{
  environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  resolveFormalRuntimeSurface?: (
    request: express.Request,
  ) => FormalCandidateRuntimeSurfaceContext | null;
  authorizeRecoveryRequest?: CandidateERecoveryBridgeAuthorizer;
}>;

type CandidateERecoveryBridgeTicket = Pick<
  CandidateERecoveryTicket,
  | "guardFile"
  | "guardDigest"
  | "reconciled"
  | "bind"
  | "complete"
  | "abort"
>;
type CandidateERecoveryBridgeAuthorizer = (
  input: Parameters<typeof authorizeCandidateESettledImageRecoveryRequest>[0],
) => CandidateERecoveryBridgeTicket | null;

function exactFormalRecoveryTrustPresent(
  surface: FormalCandidateRuntimeSurfaceContext,
): boolean {
  const trust = surface.exactAuthorizationTrustEnvironment;
  const expected = [
    RELEASE_ARTIFACT_TRUSTED_PUBLIC_KEYS_ENV,
    CANDIDATE_EXACT_AUTHORIZATION_FORMAL_LAUNCHER_TRUST_STORE_ENV,
    CANDIDATE_EXACT_AUTHORIZATION_BASE_LAUNCHER_TRUST_STORE_ENV,
  ].sort();
  const actual = Object.keys(trust).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
    && expected.every((key) => (
      typeof trust[key] === "string" && trust[key].length > 1
    ));
}

function authorizeFormalCandidateERecovery(
  request: express.Request,
  response: express.Response,
  surface: FormalCandidateRuntimeSurfaceContext,
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
  authorizeRecoveryRequest: CandidateERecoveryBridgeAuthorizer,
): boolean {
  const authorizationFile = String(
    request.header(CANDIDATE_E_IMAGE_RECOVERY_AUTHORIZATION_HEADER) || "",
  ).trim();
  const proof = String(
    request.header(CANDIDATE_E_IMAGE_RECOVERY_PROOF_HEADER) || "",
  ).trim();
  const materialize = String(
    request.header(QUICK_CREATE_IMAGE_CHECKPOINT_MATERIALIZE_HEADER) || "",
  ).trim();
  const runtimeDirectory = String(environment.FANJIN_DATA_DIR || "");
  if (
    !authorizationFile
    || !proof
    || !materialize
    || !path.isAbsolute(runtimeDirectory)
    || path.normalize(runtimeDirectory) !== runtimeDirectory
    || !path.isAbsolute(authorizationFile)
    || path.normalize(authorizationFile) !== authorizationFile
    || path.dirname(authorizationFile) !== runtimeDirectory
    || !exactFormalRecoveryTrustPresent(surface)
  ) return false;

  // The global recovery-only fence may already have verified and bound the
  // same Request object. Preserve that unforgeable capability instead of
  // trying to mint a second ticket for the same operation.
  if (candidateESettledImageRecoveryCapabilityBound(request)) {
    (response.locals as CandidateESurfaceLocals)[
      CANDIDATE_E_FORMAL_RECOVERY_AUTHORIZED
    ] = true;
    return true;
  }

  let ticket;
  try {
    ticket = authorizeRecoveryRequest({
      method: request.method,
      target: request.originalUrl || request.url || request.path,
      body: request.body,
      headers: (request.headers || {}) as Record<string, unknown>,
    });
  } catch {
    return false;
  }
  if (!ticket || ticket.reconciled) return false;

  try {
    ticket.bind(request);
  } catch {
    return false;
  }

  request.headers[QUICK_CREATE_IMAGE_CHECKPOINT_MATERIALIZE_HEADER] =
    quickCreateImageCheckpointRecoveryAuthorizedValue(ticket.guardDigest);
  (response.locals as CandidateESurfaceLocals)[
    CANDIDATE_E_FORMAL_RECOVERY_AUTHORIZED
  ] = true;
  let completed = false;
  response.once("finish", () => {
    if (completed) return;
    completed = true;
    ticket.complete(response.statusCode);
  });
  response.once("close", () => {
    if (completed) return;
    completed = true;
    ticket.abort();
  });
  return true;
}

function authorizeCandidateESurface(
  request: express.Request,
  response: express.Response,
  dependencies: CandidateESurfaceGateDependencies,
): boolean {
  const environment = dependencies.environment ?? process.env;
  if (environment.NODE_ENV === "test") return true;
  if (environment.NODE_ENV !== "prod") return false;
  const surface = (
    dependencies.resolveFormalRuntimeSurface
      ?? formalCandidateRuntimeSurfaceForRequest
  )(request);
  if (!surface) return false;
  (response.locals as CandidateESurfaceLocals)
    .candidateEFormalRuntimeSurface = surface;
  return true;
}

export function createCandidateESurfaceGateMiddleware(
  kind: "path" | "headers",
  dependencies: CandidateESurfaceGateDependencies = {},
): express.RequestHandler {
  return (request, response, next) => {
    const environment = dependencies.environment ?? process.env;
    const candidateEHeaderPresented = CANDIDATE_E_REQUEST_HEADERS.some(
      (header) => request.header(header) !== undefined,
    );
    const recoveryHeaderPresented = CANDIDATE_E_RECOVERY_REQUEST_HEADERS.some(
      (header) => request.header(header) !== undefined,
    );
    const preboundRecoveryCapability =
      environment.NODE_ENV === "prod"
      && recoveryHeaderPresented
      && candidateESettledImageRecoveryCapabilityBound(request);
    if (
      (kind === "path" || candidateEHeaderPresented)
      && !preboundRecoveryCapability
      && !authorizeCandidateESurface(request, response, dependencies)
    ) {
      sendCandidateENotFound(response);
      return;
    }
    if (
      recoveryHeaderPresented
      && !preboundRecoveryCapability
      && environment.NODE_ENV !== "test"
    ) {
      const surface = (response.locals as CandidateESurfaceLocals)
        .candidateEFormalRuntimeSurface;
      if (
        environment.NODE_ENV !== "prod"
        || !surface
        || !authorizeFormalCandidateERecovery(
          request,
          response,
          surface,
          environment,
          dependencies.authorizeRecoveryRequest
            ?? authorizeCandidateESettledImageRecoveryRequest,
        )
      ) {
        sendCandidateENotFound(response);
        return;
      }
    }
    next();
  };
}

const hideCandidateEPathOutsideTest =
  createCandidateESurfaceGateMiddleware("path");

const hideCandidateEHeadersOutsideTest =
  createCandidateESurfaceGateMiddleware("headers");

function formalCandidateESession(
  response: express.Response,
): CandidateExactAuthorizationRuntimeSession | null {
  return (response.locals as CandidateESurfaceLocals)
    .candidateEFormalRuntimeSurface?.session ?? null;
}

function formalCandidateESurface(
  response: express.Response,
): FormalCandidateRuntimeSurfaceContext | undefined {
  return (response.locals as CandidateESurfaceLocals)
    .candidateEFormalRuntimeSurface;
}

function candidateEFormalProjectMatches(
  response: express.Response,
  projectId: number | null | undefined,
): boolean {
  const session = formalCandidateESession(response);
  if (!session) return true;
  return session.projectId === projectId;
}

function candidateEFormalRuntimeAuthorized(response: express.Response): boolean {
  return formalCandidateESession(response) !== null;
}

function candidateEQuoteEnvironmentAllowed(response: express.Response): boolean {
  if (candidateEFormalRuntimeAuthorized(response)) return true;
  return process.env.FANJIN_REAL_CANDIDATE_ALLOW_VOLCANO_FAKE_IP_DNS === "1";
}

function candidateEFormalRuntimeSession(
  response: express.Response,
): CandidateExactAuthorizationRuntimeSession | undefined {
  return formalCandidateESession(response) ?? undefined;
}

function candidateEFormalProjectNotFound(
  response: express.Response,
  projectId: number | null | undefined,
): boolean {
  if (!candidateEFormalProjectMatches(response, projectId)) {
    sendCandidateENotFound(response);
    return true;
  }
  return false;
}

type ImageCapabilityLike = {
  id?: unknown;
  capabilityStatus?: unknown;
  canSubmit?: unknown;
  unavailableReason?: unknown;
  qualities?: unknown;
  defaultQuality?: unknown;
  maxOutputs?: unknown;
  aspectRatios?: unknown;
  defaultAspectRatio?: unknown;
  inputSlots?: unknown;
};

type QuickCreateImageCommandResult = {
  model: string;
  count: number;
  assets: Array<Record<string, unknown>>;
  imageTaskId?: number;
};

type QuickCreateImageCommandError = {
  message: string;
  code: string;
  deliveryTraceVersion?: "quick-create-image-no-delivery.v1";
};

const QUICK_CREATE_IMAGE_NO_DELIVERY_TRACE_VERSION =
  "quick-create-image-no-delivery.v1";

type QuickCreateImageCommandResponse =
  | QuickCreateImageCommandResult
  | QuickCreateImageCommandError;

type QuickCreateImageProviderCheckpoint = {
  version: "quick-create-image-provider.v2";
  data: Array<{ url?: string; b64_json?: string }>;
  usage?: RelayImageResult["usage"];
  billing: RelayUnitBillingCheckpoint | null;
  settlementState: "pending" | "settled";
};

type QuickCreateImageDispatchCheckpoint = {
  version: "quick-create-image-dispatch.v1";
  reservationId: string;
  requestId: string | null;
  provider: string | null;
  channelId: string | null;
  reconcileJobId: string;
  dispatchStartedAt: number;
  dispatchWatchdogAt: number;
  /** The provider explicitly instructed a retry with this same idempotency key. */
  retryableProvider503?: boolean;
  pendingMessage?: string;
  pendingUpstreamStatus?: number;
};

type QuickCreateImageCheckpoint =
  | QuickCreateImageDispatchCheckpoint
  | QuickCreateImageProviderCheckpoint;

function relayUnitBillingCheckpointData(value: unknown): RelayUnitBillingCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const checkpoint = value as Partial<RelayUnitBillingCheckpoint>;
  if (
    checkpoint.version !== "relay-unit-billing.v1"
    || !String(checkpoint.workspaceId || "").trim()
    || !String(checkpoint.requestId || "").trim()
    || !String(checkpoint.billingKey || "").trim()
    || !String(checkpoint.requestHash || "").trim()
    || !String(checkpoint.reservationId || "").trim()
    || !String(checkpoint.usageRecordId || "").trim()
    || !String(checkpoint.endpointType || "").trim()
    || !String(checkpoint.model || "").trim()
    || !String(checkpoint.source || "").trim()
    || !String(checkpoint.provider || "").trim()
    || !String(checkpoint.channelId || "").trim()
    || !String(checkpoint.pricingRuleId || "").trim()
    || !Number.isSafeInteger(checkpoint.reservedCostMicros)
    || Number(checkpoint.reservedCostMicros) <= 0
    || !Number.isSafeInteger(checkpoint.reservedUnits)
    || Number(checkpoint.reservedUnits) <= 0
    || !String(checkpoint.unit || "").trim()
    || !checkpoint.priceSnapshot
    || typeof checkpoint.priceSnapshot !== "object"
    || Array.isArray(checkpoint.priceSnapshot)
  ) {
    return null;
  }
  return checkpoint as RelayUnitBillingCheckpoint;
}

function providerCheckpointData(value: unknown): QuickCreateImageProviderCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const checkpoint = value as Partial<QuickCreateImageProviderCheckpoint>;
  if (
    checkpoint.version !== "quick-create-image-provider.v2"
    || !Array.isArray(checkpoint.data)
    || !["pending", "settled"].includes(String(checkpoint.settlementState || ""))
  ) {
    return null;
  }
  const billing = relayUnitBillingCheckpointData(checkpoint.billing);
  if (!billing) return null;
  const data = checkpoint.data.filter((item): item is { url?: string; b64_json?: string } => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    return (
      typeof record.url === "string" && record.url.trim().length > 0
      || typeof record.b64_json === "string" && record.b64_json.trim().length > 0
    );
  });
  if (data.length !== checkpoint.data.length) return null;
  const settlementState = checkpoint.settlementState === "pending"
    ? "pending"
    : "settled";
  return {
    version: checkpoint.version,
    data,
    ...(checkpoint.usage ? { usage: checkpoint.usage } : {}),
    billing,
    settlementState,
  };
}

function dispatchCheckpointData(value: unknown): QuickCreateImageDispatchCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const checkpoint = value as Partial<QuickCreateImageDispatchCheckpoint>;
  if (
    checkpoint.version !== "quick-create-image-dispatch.v1"
    || typeof checkpoint.reservationId !== "string"
    || !checkpoint.reservationId.trim()
    || typeof checkpoint.reconcileJobId !== "string"
    || !checkpoint.reconcileJobId.trim()
    || !Number.isSafeInteger(checkpoint.dispatchStartedAt)
    || !Number.isSafeInteger(checkpoint.dispatchWatchdogAt)
    || Number(checkpoint.dispatchWatchdogAt) <= Number(checkpoint.dispatchStartedAt)
  ) {
    return null;
  }
  return {
    version: checkpoint.version,
    reservationId: checkpoint.reservationId,
    requestId: checkpoint.requestId == null ? null : String(checkpoint.requestId),
    provider: checkpoint.provider == null ? null : String(checkpoint.provider),
    channelId: checkpoint.channelId == null ? null : String(checkpoint.channelId),
    reconcileJobId: checkpoint.reconcileJobId,
    dispatchStartedAt: Number(checkpoint.dispatchStartedAt),
    dispatchWatchdogAt: Number(checkpoint.dispatchWatchdogAt),
    ...(checkpoint.retryableProvider503 === true ? { retryableProvider503: true } : {}),
    ...(typeof checkpoint.pendingMessage === "string" && checkpoint.pendingMessage.length <= 1000
      ? { pendingMessage: checkpoint.pendingMessage } : {}),
    ...(Number.isInteger(checkpoint.pendingUpstreamStatus) && Number(checkpoint.pendingUpstreamStatus) >= 100
      && Number(checkpoint.pendingUpstreamStatus) <= 599 ? { pendingUpstreamStatus: checkpoint.pendingUpstreamStatus } : {}),
  };
}

function parseCheckpointJsonRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function hasClosedImageSettlement(
  checkpoint: RelayUnitBillingCheckpoint,
  returnedCount: number,
  expectedCommand?: {
    id: string;
    workspaceId: string;
    actorUserId: number;
    scopeKey: string;
    idempotencyKey: string;
    requestHash: string;
  },
): Promise<boolean> {
  if (
    checkpoint?.version !== "relay-unit-billing.v1"
    || !String(checkpoint.workspaceId || "").trim()
    || !String(checkpoint.requestId || "").trim()
    || !String(checkpoint.billingKey || "").trim()
    || !String(checkpoint.requestHash || "").trim()
    || !String(checkpoint.reservationId || "").trim()
    || !String(checkpoint.usageRecordId || "").trim()
    || !String(checkpoint.provider || "").trim()
    || !String(checkpoint.channelId || "").trim()
    || !String(checkpoint.pricingRuleId || "").trim()
    || !Number.isSafeInteger(checkpoint.reservedCostMicros)
    || checkpoint.reservedCostMicros <= 0
    || !Number.isSafeInteger(checkpoint.reservedUnits)
    || checkpoint.reservedUnits <= 0
    || checkpoint.reservedUnits !== returnedCount
    || checkpoint.unit !== "image"
  ) {
    return false;
  }
  const [reservation, usage, relatedLedgers, usageLedgers] = await Promise.all([
    db("o_billing_ledger")
      .where({
        id: checkpoint.reservationId,
        workspaceId: checkpoint.workspaceId,
        type: "freeze",
      })
      .first(),
    db("o_usage_record")
      .where({
        id: checkpoint.usageRecordId,
        workspaceId: checkpoint.workspaceId,
      })
      .first(),
    db("o_billing_ledger")
      .where({
        workspaceId: checkpoint.workspaceId,
        relatedLedgerId: checkpoint.reservationId,
      })
      .select("*"),
    db("o_billing_ledger")
      .where({
        workspaceId: checkpoint.workspaceId,
        relatedUsageId: checkpoint.usageRecordId,
      })
      .select("*"),
  ]);
  const captures = relatedLedgers.filter((row) => String(row.type || "") === "deduct");
  const releases = relatedLedgers.filter((row) => String(row.type || "") === "release");
  if (
    !reservation
    || !usage
    || relatedLedgers.length !== 1
    || captures.length !== 1
    || releases.length !== 0
    || usageLedgers.length !== 2
  ) return false;
  const capture = captures[0];
  const metadata = parseCheckpointJsonRecord(reservation.metadata);
  const captureMetadata = parseCheckpointJsonRecord(capture.metadata);
  const durableCommandIdentity = parseCheckpointJsonRecord(
    metadata.durableCommandIdentity,
  );
  const usageLedgerIds = new Set(
    usageLedgers.map((row) => String(row.id || "")),
  );
  return (
    Number(reservation.amountMicros || 0) === checkpoint.reservedCostMicros
    && Number(reservation.remainingMicros || 0) === 0
    && String(reservation.status || "") === "captured"
    && String(reservation.relatedUsageId || "") === checkpoint.usageRecordId
    && String(reservation.requestId || "") === checkpoint.requestId
    && String(metadata.requestHash || "") === checkpoint.requestHash
    && String(metadata.pricingRuleId || "") === checkpoint.pricingRuleId
    && Number(metadata.reservedUnits || 0) === checkpoint.reservedUnits
    && String(metadata.source || "") === checkpoint.source
    && String(metadata.dispatchProvider || "") === checkpoint.provider
    && String(metadata.dispatchChannelId || "") === checkpoint.channelId
    && String(metadata.dispatchRequestId || "") === checkpoint.requestId
    && (
      !expectedCommand
      || (
        String(durableCommandIdentity.contractVersion || "")
          === "workbench-generation-command.v1"
        && String(durableCommandIdentity.commandId || "") === expectedCommand.id
        && String(durableCommandIdentity.workspaceId || "")
          === expectedCommand.workspaceId
        && Number(durableCommandIdentity.actorUserId)
          === expectedCommand.actorUserId
        && String(durableCommandIdentity.scopeKey || "")
          === expectedCommand.scopeKey
        && String(durableCommandIdentity.idempotencyKey || "")
          === expectedCommand.idempotencyKey
        && String(durableCommandIdentity.requestHash || "")
          === expectedCommand.requestHash
      )
    )
    && String(usage.endpointType || "") === checkpoint.endpointType
    && String(usage.model || "") === checkpoint.model
    && String(usage.provider || "") === checkpoint.provider
    && String(usage.channelId || "") === checkpoint.channelId
    && Number(usage.units || 0) === checkpoint.reservedUnits
    && String(usage.unit || "") === checkpoint.unit
    && Number(usage.costMicros || 0) === checkpoint.reservedCostMicros
    && String(usage.currency || "") === "GU"
    && String(usage.status || "") === "charged"
    && String(capture.idempotencyKey || "") === `${checkpoint.billingKey}:capture`
    && String(capture.relatedUsageId || "") === checkpoint.usageRecordId
    && Number(capture.amountMicros || 0) === checkpoint.reservedCostMicros
    && String(reservation.currency || "") === "GU"
    && String(capture.currency || "") === "GU"
    && String(capture.status || "") === "succeeded"
    && String(capture.requestId || "") === checkpoint.requestId
    && String(captureMetadata.requestHash || "") === checkpoint.requestHash
    && String(captureMetadata.pricingRuleId || "") === checkpoint.pricingRuleId
    && String(captureMetadata.source || "") === checkpoint.source
    && usageLedgerIds.size === 2
    && usageLedgerIds.has(String(reservation.id || ""))
    && usageLedgerIds.has(String(capture.id || ""))
  );
}

const referenceSchema = z.object({
  assetVersionId: z.string().trim().min(1).max(200),
  role: z.enum(GENERATION_REFERENCE_ROLES),
});

const pricingConfirmationSchema = z.object({
  token: z.string().trim().min(1).max(16_384).optional(),
  acceptedUnitMaximumCostMicros: z.number().int().positive()
    .max(Number.MAX_SAFE_INTEGER).optional(),
  batchIdempotencyKey: z.string().trim().min(1).max(300).optional(),
  batchSize: z.number().int().min(1).max(8).optional().default(1),
  itemIndex: z.number().int().min(1).max(8).optional().default(1),
}).strict();

function canSubmitCapability(entry: ImageCapabilityLike | null | undefined): entry is ImageCapabilityLike & {
  id: string;
  capabilityStatus: string;
  canSubmit: true;
} {
  return Boolean(
    entry
    && typeof entry.id === "string"
    && entry.id.trim()
    && entry.canSubmit === true
    && SUBMITTABLE_CAPABILITY_STATUSES.has(String(entry.capabilityStatus)),
  );
}

function capabilityValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

type ImageReferenceRole = GenerationReference["role"];
type ImageSlotMediaKind = "image" | "video" | "file";

type NormalizedImageInputSlot = {
  id: string;
  label: string;
  accepts: Set<ImageSlotMediaKind>;
  roles: Set<ImageReferenceRole>;
  min: number;
  max: number;
};

type ImageReferenceInputValidation =
  | { ok: true; imageUrls: string[] }
  | { ok: false; message: string };

const IMAGE_REFERENCE_ROLES = new Set<ImageReferenceRole>(GENERATION_REFERENCE_ROLES);
const GENERIC_IMAGE_REFERENCE_ROLES: ImageReferenceRole[] = ["subject", "style", "storyboard"];

function slotToken(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "";
}

function slotList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(",");
  return null;
}

function normalizeImageSlotRoles(value: unknown): ImageReferenceRole[] {
  const normalized = slotToken(value);
  if (IMAGE_REFERENCE_ROLES.has(normalized as ImageReferenceRole)) {
    return [normalized as ImageReferenceRole];
  }
  if (["firstframe", "start_frame", "startframe", "first_frame_image"].includes(normalized)) {
    return ["first_frame"];
  }
  if (["lastframe", "end_frame", "endframe", "tail_frame", "last_frame_image"].includes(normalized)) {
    return ["last_frame"];
  }
  if (["character", "character_reference", "subject_reference"].includes(normalized)) return ["subject"];
  if (normalized === "style_reference") return ["style"];
  if (normalized === "storyboard_reference") return ["storyboard"];
  if ([
    "reference",
    "references",
    "reference_image",
    "image_reference",
    "reference_images",
    "image_references",
  ].includes(normalized)) {
    return [...GENERIC_IMAGE_REFERENCE_ROLES];
  }
  return [];
}

function normalizeImageSlotAccept(value: unknown): ImageSlotMediaKind | "" {
  const normalized = slotToken(value);
  if (["image", "images", "image_url"].includes(normalized) || normalized.startsWith("image/")) return "image";
  if (["video", "videos", "video_url"].includes(normalized) || normalized.startsWith("video/")) return "video";
  if (
    ["file", "files", "document", "audio", "audio_url"].includes(normalized)
    || normalized.startsWith("audio/")
    || normalized.startsWith("application/")
  ) return "file";
  return "";
}

function imageSlotInteger(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) ? normalized : null;
}

function parseImageInputSlots(value: unknown): { slots: NormalizedImageInputSlot[]; error?: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { slots: [], error: "当前图片模型目录未声明参考图 inputSlot" };
  }

  const slots: NormalizedImageInputSlot[] = [];
  const slotIds = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { slots: [], error: `图片模型第 ${index + 1} 个 inputSlot 声明无效` };
    }
    const slot = raw as Record<string, unknown>;
    const id = typeof slot.id === "string" && slot.id.trim()
      ? slot.id.trim()
      : typeof slot.role === "string" && slot.role.trim()
        ? slot.role.trim()
        : "";
    const rawRoles = slotList(slot.roles ?? slot.referenceRoles ?? slot.acceptedRoles)
      ?? [slot.role ?? slot.id];
    const roles = new Set<ImageReferenceRole>();
    for (const rawRole of rawRoles) {
      const normalizedRoles = normalizeImageSlotRoles(rawRole);
      if (!normalizedRoles.length) {
        return { slots: [], error: `图片模型 inputSlot ${id || index + 1} 的 role 声明无效` };
      }
      normalizedRoles.forEach((role) => roles.add(role));
    }

    const rawAccepts = slotList(slot.accepts ?? slot.accept);
    if (!rawAccepts?.length) {
      return { slots: [], error: `图片模型 inputSlot ${id || index + 1} 缺少 accepts 声明` };
    }
    const accepts = new Set<ImageSlotMediaKind>();
    for (const rawAccept of rawAccepts) {
      const normalizedAccept = normalizeImageSlotAccept(rawAccept);
      if (!normalizedAccept) {
        return { slots: [], error: `图片模型 inputSlot ${id || index + 1} 的 accepts 声明无效` };
      }
      accepts.add(normalizedAccept);
    }

    const required = slot.required === undefined ? false : slot.required;
    if (typeof required !== "boolean") {
      return { slots: [], error: `图片模型 inputSlot ${id || index + 1} 的 required 声明无效` };
    }
    const min = slot.min === undefined ? (required ? 1 : 0) : imageSlotInteger(slot.min);
    const max = slot.max === undefined
      ? Math.max(typeof min === "number" ? min : 0, 1)
      : imageSlotInteger(slot.max);
    if (
      !id
      || slotIds.has(id)
      || roles.size === 0
      || accepts.size === 0
      || min === null
      || max === null
      || min < 0
      || max < 1
      || max < min
      || (required && min < 1)
    ) {
      return { slots: [], error: `图片模型 inputSlot ${id || index + 1} 的 role/accepts/min/max 声明不完整` };
    }
    slotIds.add(id);
    slots.push({
      id,
      label: typeof slot.label === "string" && slot.label.trim() ? slot.label.trim() : id,
      accepts,
      roles,
      min,
      max,
    });
  }
  return { slots };
}

function validateImageReferenceInputs(
  inputSlots: unknown,
  references: GenerationReference[],
  referenceContent: Record<string, unknown>[],
): ImageReferenceInputValidation {
  const parsed = parseImageInputSlots(inputSlots);
  if (parsed.error) return { ok: false, message: parsed.error };
  if (references.length !== referenceContent.length) {
    return { ok: false, message: "图片参考素材解析结果与请求不一致" };
  }

  const normalized: Array<{ role: ImageReferenceRole; url: string }> = [];
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    const content = referenceContent[index];
    if (!content || content.reference_role !== reference.role) {
      return { ok: false, message: "图片参考素材角色映射无效" };
    }
    if (content.type !== "image_url") {
      return { ok: false, message: "图片生成不支持视频参考素材" };
    }
    const imageUrl = content.image_url;
    const url = imageUrl && typeof imageUrl === "object" && !Array.isArray(imageUrl)
      ? (imageUrl as Record<string, unknown>).url
      : null;
    if (typeof url !== "string" || !url.trim()) {
      return { ok: false, message: "图片参考素材缺少可用的 image_url.url" };
    }
    normalized.push({ role: reference.role, url: url.trim() });
  }

  const counts = new Map(parsed.slots.map((slot) => [slot.id, 0]));
  for (const reference of normalized) {
    const compatible = parsed.slots
      .filter((slot) => slot.roles.has(reference.role) && slot.accepts.has("image"))
      .sort((left, right) => {
        const leftNeedsMinimum = Number(counts.get(left.id) || 0) < left.min ? 0 : 1;
        const rightNeedsMinimum = Number(counts.get(right.id) || 0) < right.min ? 0 : 1;
        return leftNeedsMinimum - rightNeedsMinimum
          || left.roles.size - right.roles.size
          || left.max - right.max;
      });
    const target = compatible.find((slot) => Number(counts.get(slot.id) || 0) < slot.max);
    if (!target) {
      const roleSlots = parsed.slots.filter((slot) => slot.roles.has(reference.role));
      if (!roleSlots.length) {
        return { ok: false, message: `图片参考素材角色 ${reference.role} 未声明对应 inputSlot` };
      }
      if (!roleSlots.some((slot) => slot.accepts.has("image"))) {
        return { ok: false, message: `图片参考素材角色 ${reference.role} 的 inputSlot 不接受 image 类型` };
      }
      return { ok: false, message: `图片参考素材角色 ${reference.role} 超过 inputSlot 数量上限` };
    }
    counts.set(target.id, Number(counts.get(target.id) || 0) + 1);
  }

  for (const slot of parsed.slots) {
    const count = Number(counts.get(slot.id) || 0);
    if (count < slot.min) {
      return { ok: false, message: `${slot.label} 至少需要 ${slot.min} 个图片参考素材` };
    }
  }
  return { ok: true, imageUrls: normalized.map((reference) => reference.url) };
}

function unavailableModelResponse(
  res: express.Response,
  requestedModel: string | undefined,
  unavailableReason?: unknown,
) {
  if (!requestedModel) {
    return res.status(503).send({ message: "当前工作区没有可用的默认图片模型" });
  }
  return res.status(422).send({
    message: typeof unavailableReason === "string" && unavailableReason.trim()
      ? unavailableReason
      : "所选图片模型当前不可提交",
  });
}

function publicProjectImages(
  assets: Array<PersistedGeneratedImage | PersistedGeneratedWorkspaceImage>,
): Array<Record<string, unknown>> {
  return assets.map((asset) => ({
    id: asset.mediaAssetId,
    mediaAssetId: asset.mediaAssetId,
    assetId: asset.assetId,
    assetVersionId: asset.assetVersionId,
    taskId: asset.taskId,
    url: asset.url,
    contentSha256: asset.contentSha256,
    assetType: asset.assetType,
    model: asset.model,
    prompt: asset.prompt,
    createdAt: asset.createdAt,
  }));
}

function candidateERecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function candidateEJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return candidateERecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function candidateEExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function candidateEPositiveInteger(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized > 0
    ? normalized
    : null;
}

type CandidateECompletedImageMaterialization = Readonly<{
  response: QuickCreateImageCommandResult;
  proof: CandidateERecoveryMaterializationProof;
}>;

/**
 * Read-only reconciliation for the one crash window where the asset graph and
 * durable 200 response committed but the filesystem recovery receipt did not.
 * Every durable row is bound back to the exact command; this function performs
 * SELECTs only and never touches provider, billing or object storage.
 */
type CandidateECompletedImageMaterializationInput = Readonly<{
  commandId: string;
  workspaceId: string;
  actorUserId: number;
  scopeKey: string;
  idempotencyKey: string;
  requestHash: string;
  projectId: number;
  model: string;
  ratio: string;
  quality: string;
  resolution: string;
  prompt: string;
}>;

async function attestCandidateECompletedImageMaterializationSnapshot(
  database: Knex | Knex.Transaction,
  input: CandidateECompletedImageMaterializationInput,
): Promise<CandidateECompletedImageMaterialization | null> {
  const commands = await database("o_agent_idempotency")
    .where({
      id: input.commandId,
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      scopeKey: input.scopeKey,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      resourceType: "workbench_generation_command",
      status: "completed",
      responseStatus: 200,
    })
    .whereNull("resourceId")
    .select("id", "responseBody")
    .limit(2);
  if (commands.length !== 1) return null;
  const response = candidateEJsonRecord(commands[0].responseBody);
  if (
    !response
    || !candidateEExactKeys(response, ["model", "count", "assets"])
    || response.model !== input.model
    || response.count !== 1
    || !Array.isArray(response.assets)
    || response.assets.length !== 1
  ) return null;
  const responseAsset = candidateERecord(response.assets[0]);
  if (
    !responseAsset
    || !candidateEExactKeys(responseAsset, [
      "id", "mediaAssetId", "assetId", "assetVersionId", "taskId", "url",
      "contentSha256", "assetType", "model", "prompt", "createdAt",
    ])
  ) return null;
  const mediaAssetId = String(responseAsset.mediaAssetId || "");
  const assetId = candidateEPositiveInteger(responseAsset.assetId);
  const assetVersionId = candidateEPositiveInteger(responseAsset.assetVersionId);
  const taskId = String(responseAsset.taskId || "");
  const assetUrl = String(responseAsset.url || "");
  const contentSha256 = String(responseAsset.contentSha256 || "");
  const createdAt = candidateEPositiveInteger(responseAsset.createdAt);
  if (
    !mediaAssetId
    || responseAsset.id !== mediaAssetId
    || !assetId
    || !assetVersionId
    || !taskId
    || !assetUrl
    || !/^[a-f0-9]{64}$/u.test(contentSha256)
    || !createdAt
    || responseAsset.assetType !== "image"
    || responseAsset.model !== input.model
    || responseAsset.prompt !== input.prompt
  ) return null;

  const [mediaRows, assetRows, imageRows] = await Promise.all([
    database("o_media_asset")
      .where({
        id: mediaAssetId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        source: "quick-create",
        assetType: "image",
      })
      .select("*")
      .limit(2),
    database("o_assets")
      .where({ id: assetId, projectId: input.projectId })
      .select("*")
      .limit(2),
    database("o_image")
      .where({ id: assetVersionId, assetsId: assetId })
      .select("*")
      .limit(2),
  ]);
  if (mediaRows.length !== 1 || assetRows.length !== 1 || imageRows.length !== 1) {
    return null;
  }
  const media = mediaRows[0];
  const asset = assetRows[0];
  const image = imageRows[0];
  const metadata = candidateEJsonRecord(media.metadata);
  const storageKey = String(media.storageKey || "");
  if (
    !metadata
    || !storageKey
    || String(media.localPath || "") !== storageKey
    || String(media.taskId || "") !== taskId
    || String(media.url || "") !== assetUrl
    || Number(media.createTime) !== createdAt
    || metadata.version !== "generated-project-image.v1"
    || metadata.generationCommandId !== input.commandId
    || metadata.generationRequestHash !== input.requestHash
    || metadata.generationIdempotencyKey !== input.idempotencyKey
    || metadata.prompt !== input.prompt
    || metadata.finalPrompt !== input.prompt
    || metadata.model !== input.model
    || metadata.ratio !== input.ratio
    || metadata.quality !== input.quality
    || metadata.resolution !== input.resolution
    || metadata.index !== 0
    || metadata.controlledStorage !== true
    || metadata.contentSha256 !== contentSha256
    || Number(metadata.assetId) !== assetId
    || Number(metadata.assetVersionId) !== assetVersionId
    || Number(asset.imageId) !== assetVersionId
    || String(asset.type || "") !== "image"
    || String(asset.prompt || "") !== input.prompt
    || Number(image.assetsId) !== assetId
    || String(image.storageKey || "") !== storageKey
    || String(image.filePath || "") !== storageKey
    || String(image.type || "") !== "image"
    || String(image.model || "") !== input.model
    || String(image.resolution || "") !== input.resolution
    || String(image.state || "") !== "已完成"
  ) return null;

  const intentRows = await database("o_object_write_intent")
    .where({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      purpose: "agent_generation",
      objectKey: storageKey,
      status: "committed",
    })
    .select("*")
    .limit(2);
  if (intentRows.length !== 1) return null;
  const intent = intentRows[0];
  const reference = candidateEJsonRecord(intent.referenceJson);
  const expectedReference = {
    version: "object-write-reference.v1",
    table: "o_media_asset",
    rowId: mediaAssetId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    storageKey,
  };
  const referenceJson = String(intent.referenceJson || "");
  const writeReceiptJson = String(intent.writeReceiptJson || "");
  const sha256Hex = (value: string) => crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
  if (
    !reference
    || candidateERecoveryStableJson(reference)
      !== candidateERecoveryStableJson(expectedReference)
    || referenceJson !== candidateERecoveryStableJson(expectedReference)
    || String(intent.referenceHash || "") !== sha256Hex(referenceJson)
    || String(intent.expectedSha256 || "") !== contentSha256
    || !candidateEPositiveInteger(intent.expectedSize)
    || !candidateEJsonRecord(writeReceiptJson)
    || String(intent.writeReceiptHash || "") !== sha256Hex(writeReceiptJson)
    || !candidateEPositiveInteger(intent.putCompletedAt)
    || !candidateEPositiveInteger(intent.committedAt)
    || intent.compensationEvidenceJson != null
    || intent.compensationEvidenceHash != null
    || intent.errorCode != null
    || intent.leaseOwner != null
    || intent.leaseExpiresAt != null
    || intent.compensatedAt != null
  ) return null;

  const fingerprint = candidateERecoverySha256(
    candidateERecoveryStableJson({
      version: "fanjin-candidate-e-completed-image-materialization/v1",
      command: {
        id: input.commandId,
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        scopeKey: input.scopeKey,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        response,
      },
      media: {
        id: mediaAssetId,
        taskId,
        url: assetUrl,
        storageKey,
        mimeType: String(media.mimeType || ""),
        createTime: createdAt,
        metadata,
      },
      asset: { id: assetId, imageId: assetVersionId, type: "image" },
      image: {
        id: assetVersionId,
        assetsId: assetId,
        storageKey,
        model: input.model,
        resolution: input.resolution,
        state: "已完成",
      },
      objectIntent: {
        id: String(intent.id || ""),
        objectKey: storageKey,
        expectedSize: Number(intent.expectedSize),
        expectedSha256: String(intent.expectedSha256),
        providerFingerprint: String(intent.providerFingerprint || ""),
        writeReceiptHash: String(intent.writeReceiptHash),
        referenceHash: String(intent.referenceHash),
        committedAt: Number(intent.committedAt),
      },
    }),
  );
  return Object.freeze({
    response: response as unknown as QuickCreateImageCommandResult,
    proof: Object.freeze({
      durableCommandId: input.commandId,
      assetFingerprint: fingerprint,
    }),
  });
}

async function attestCandidateECompletedImageMaterialization(
  input: CandidateECompletedImageMaterializationInput,
): Promise<CandidateECompletedImageMaterialization | null> {
  // A deferred, SELECT-only transaction gives every graph query one SQLite
  // snapshot. It closes the audit before the filesystem receipt is sealed and
  // cannot repeat provider, object-storage, finance, or database writes.
  return db.transaction((transaction) => (
    attestCandidateECompletedImageMaterializationSnapshot(transaction, input)
  ));
}

function publicRelayImageError(status: number): string {
  if (status === 429) return "图片生成请求过于频繁，请稍后重试";
  if ([400, 413, 415, 422].includes(status)) return "图片生成参数不受支持";
  if ([401, 403].includes(status)) return "图片生成服务认证失败";
  if (status === 404) return "图片生成服务不可用";
  if (status === 409) return "图片生成请求冲突，请刷新后重试";
  return "图片生成服务暂时不可用";
}

function pendingDispatchReconcileBody(error?: unknown): QuickCreateImageCommandError {
  return quickCreateImagePendingReconcileBody(error);
}

router.post(
  "/candidate-e-settled-quote",
  hideCandidateEPathOutsideTest,
  requireActiveWorkspacePermission("generation:create"),
  requireProjectPermission("generation:create"),
  validateFields({
    projectId: z.number().int().positive(),
    prompt: z.string().trim().min(1).max(4_096),
    model: z.string().trim().min(1).max(200),
    ratio: z.string().regex(/^\d{1,3}:\d{1,3}$/),
    quality: z.string().trim().min(1).max(20),
    count: z.literal(1),
  }),
  async (req, res) => {
    if (
      !candidateEQuoteEnvironmentAllowed(res)
      || req.header(CANDIDATE_E_SETTLED_IMAGE_QUOTE_HEADER)
        !== CANDIDATE_E_SETTLED_IMAGE_QUOTE_VALUE
      || req.header(CANDIDATE_E_SETTLED_IMAGE_ACK_HEADER)
        !== CANDIDATE_E_SETTLED_IMAGE_ACK_VALUE
    ) {
      return res.status(403).send({
        message: "Candidate E 实时报价只允许受控候选验收",
        code: "candidate_e_quote_forbidden",
      });
    }
    const workspaceId = resolveRelayWorkspaceId(req) || "default";
    const actorUserId = Number((req as any).auth?.user?.id || 0);
    const body = req.body as {
      projectId: number;
      prompt: string;
      model: string;
      ratio: string;
      quality: string;
      count: 1;
    };
    if (candidateEFormalProjectNotFound(res, body.projectId)) return;
    const idempotencyKey = readRequiredIdempotencyKey(req, res);
    if (!idempotencyKey) return;
    const capability = await resolveWorkbenchModelCapability({
      workspaceId,
      endpointType: "image_generation",
      model: body.model,
    });
    if (!canSubmitCapability(capability)) {
      return unavailableModelResponse(res, body.model, capability?.unavailableReason);
    }
    if (
      !capabilityValues(capability.qualities).includes(body.quality)
      || !capabilityValues(capability.aspectRatios).includes(body.ratio)
      || !resolveVolcengineImageSize(body.quality, body.ratio)
    ) {
      return res.status(422).send({
        message: "Candidate E 报价的图片能力组合不受支持",
        code: "candidate_e_quote_capability_invalid",
      });
    }
    const candidates = await selectChannelCandidates({
      endpointType: "image_generation",
      model: capability.id,
      workspaceId,
    });
    if (candidates.length !== 1) {
      return res.status(409).send({
        message: "Candidate E 需要唯一确定的图片主路由通道",
        code: "candidate_e_quote_route_not_unique",
      });
    }
    const channel = candidates[0];
    const allRoutes = await db("o_model_route")
      .where({ endpointType: "image_generation", model: capability.id })
      .orderBy("priority", "asc")
      .orderBy("fallbackOrder", "asc")
      .orderBy("createTime", "asc")
      .orderBy("id", "asc");
    const routes = selectPreferredModelRouteScope(allRoutes, workspaceId)
      .filter((route) => (
        !Boolean(Number(route.disabled || 0))
        && String(route.channelId || "") === channel.id
        && String(route.provider || "") === channel.provider
      ));
    if (routes.length !== 1) {
      return res.status(409).send({
        message: "Candidate E 主路由无法绑定唯一候选实体",
        code: "candidate_e_quote_route_not_unique",
      });
    }
    const route = routes[0];
    const pricing = await resolveProviderSpecificPricingRule({
      endpointType: "image_generation",
      provider: channel.provider,
      model: capability.id,
      workspaceId,
    });
    if (!pricing || pricing.unit !== "image" || pricing.currency !== "GU") {
      return res.status(409).send({
        message: "Candidate E 图片路由缺少精确 GU 定价",
        code: "candidate_e_quote_pricing_unavailable",
      });
    }
    const ruleConfig = pricing.ruleConfig || {};
    const issuedAt = Date.now();
    const maximumCostMicros = calculatePricingCost(pricing, 1);
    const routeUpdatedAt = Number(route.updateTime || route.updatedAt || 0);
    const pricingRuleUpdatedAt = Number(pricing.updateTime || 0);
    const multiplier = Number(ruleConfig.multiplier ?? 1);
    const minimumMicros = Number(ruleConfig.minimumMicros ?? 0);
    if (
      !Number.isSafeInteger(maximumCostMicros)
      || maximumCostMicros <= 0
      || !Number.isSafeInteger(routeUpdatedAt)
      || routeUpdatedAt <= 0
      || !Number.isSafeInteger(pricingRuleUpdatedAt)
      || pricingRuleUpdatedAt <= 0
    ) {
      return res.status(409).send({
        message: "Candidate E 实时报价数据不完整",
        code: "candidate_e_quote_pricing_unavailable",
      });
    }
    const routeBinding = {
      routeId: String(route.id),
      routeAlias: String(route.name || route.id),
      routeUpdatedAt,
      model: capability.id,
      provider: channel.provider,
      channelId: channel.id,
      pricingRuleId: pricing.id,
      pricingRuleUpdatedAt,
      unitPriceMicros: pricing.unitPriceMicros,
      multiplier,
      minimumMicros,
    };
    const quote = {
      version: CANDIDATE_E_SETTLED_IMAGE_QUOTE_VERSION,
      endpointType: "image_generation" as const,
      workspaceId,
      model: capability.id,
      provider: channel.provider,
      channelId: channel.id,
      routeId: String(route.id),
      routeAlias: String(route.name || route.id),
      routeUpdatedAt,
      pricingRuleId: pricing.id,
      pricingRuleUpdatedAt,
      unit: "image" as const,
      unitPriceMicros: pricing.unitPriceMicros,
      multiplier,
      minimumMicros,
      requestUnits: 1 as const,
      ratio: body.ratio,
      quality: body.quality,
      maximumCostMicros,
      currency: "GU" as const,
      routeDigest: candidateERouteDigest(routeBinding),
      issuedAt,
      expiresAt: issuedAt + CANDIDATE_E_SETTLED_IMAGE_QUOTE_LIFETIME_MS,
    };
    const commandRequest = {
      projectId: body.projectId,
      targetAssetId: null,
      prompt: body.prompt,
      finalPrompt: body.prompt,
      model: capability.id,
      ratio: body.ratio,
      quality: body.quality,
      count: 1,
      subjects: [],
      skills: [],
      references: [],
    };
    return res.status(200).send(success({
      quote,
      quoteDigest: candidateEQuoteDigest(quote),
      requestHash: hashIdempotencyRequest(commandRequest),
      idempotencyKeySha256: candidateESha256(idempotencyKey),
      actorUserId,
      projectId: body.projectId,
      upstreamCalls: 0,
      chargedCalls: 0,
    }));
  },
);

router.post("/tasks/status", ...projectImageTaskStatusHandlers);
router.post("/tasks/cancel", ...projectImageTaskCancelHandlers);

export default router.post(
  "/",
  hideCandidateEHeadersOutsideTest,
  requireActiveWorkspacePermission("generation:create"),
  (req, res, next) => {
    if (
      typeof req.body?.projectId === "number"
      && Number.isSafeInteger(req.body.projectId)
      && req.body.projectId > 0
      || Array.isArray(req.body?.references) && req.body.references.length > 0
    ) {
      return requireProjectPermission("generation:create")(req, res, next);
    }
    return next();
  },
  validateFields({
    prompt: z.string().min(1),
    model: z.string().optional().nullable(),
    ratio: z.string().regex(/^\d{1,3}:\d{1,3}$/).optional().nullable(),
    quality: z.string().trim().min(1).max(20).optional().nullable(),
    count: z.number().int().min(1).max(1).optional().default(1),
    style: z.string().optional().nullable(),
    subjects: z.array(z.object({ id: z.number().optional(), name: z.string().optional(), type: z.string().optional() })).optional().default([]),
    skills: z.array(z.object({ id: z.string().optional(), name: z.string().optional() })).optional().default([]),
    projectId: z.number().int().positive().optional(),
    targetAssetId: z.number().int().positive().optional(),
    references: z.array(referenceSchema).max(MAX_QUICK_CREATE_IMAGE_REFERENCES).optional().default([]),
    referenceImages: z.array(z.unknown()).max(MAX_QUICK_CREATE_IMAGE_REFERENCES).optional().default([]),
    pricingConfirmation: pricingConfirmationSchema.optional(),
  }),
  async (req, res) => {
    const recoveryCapabilityBound =
      candidateESettledImageRecoveryCapabilityBound(req);
    const formalRecoveryAuthorized = (res.locals as CandidateESurfaceLocals)[
      CANDIDATE_E_FORMAL_RECOVERY_AUTHORIZED
    ] === true;
    const checkpointMaterializeMode = formalRecoveryAuthorized
      ? recoveryCapabilityBound ? "enabled" : "forbidden"
      : recoveryCapabilityBound
        ? "enabled"
        : quickCreateImageCheckpointMaterializeOnly(
            req.header(QUICK_CREATE_IMAGE_CHECKPOINT_MATERIALIZE_HEADER),
          );
    if (checkpointMaterializeMode === "forbidden") {
      return res.status(403).send({
        message: "图片检查点素材化模式不可用",
        code: "image_checkpoint_materialize_forbidden",
      });
    }
    const checkpointMaterializeOnly =
      checkpointMaterializeMode === "enabled";
    const workspaceId = resolveRelayWorkspaceId(req) || "default";
    const body = req.body as {
      prompt: string;
      model?: string | null;
      ratio?: string | null;
      quality?: string | null;
      count?: number;
      style?: string | null;
      subjects?: Array<{ id?: number; name?: string; type?: string }>;
      skills?: Array<{ id?: string; name?: string }>;
      projectId?: number;
      targetAssetId?: number;
      references?: GenerationReference[];
      referenceImages?: unknown[];
      pricingConfirmation?: {
        token?: string;
        acceptedUnitMaximumCostMicros?: number;
        batchIdempotencyKey?: string;
        batchSize: number;
        itemIndex: number;
      };
    };
    if (
      checkpointMaterializeOnly
      && (
        body.targetAssetId !== undefined
        || body.projectId === undefined
      )
    ) {
      return res.status(409).send({
        message: "图片检查点素材化只允许恢复原项目中的新建图片",
        code: "image_checkpoint_materialize_precondition_failed",
      });
    }

    const requestedModel = typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : undefined;
    const capability = await resolveWorkbenchModelCapability({
      workspaceId,
      endpointType: "image_generation",
      model: requestedModel,
    });
    if (!canSubmitCapability(capability)) {
      return unavailableModelResponse(res, requestedModel, capability?.unavailableReason);
    }

    const model = capability.id;
    const qualities = capabilityValues(capability.qualities);
    const aspectRatios = capabilityValues(capability.aspectRatios);
    const requestedQuality = typeof body.quality === "string" && body.quality
      ? body.quality
      : undefined;
    const requestedRatio = typeof body.ratio === "string" && body.ratio
      ? body.ratio
      : undefined;
    const defaultQuality = typeof capability.defaultQuality === "string"
      ? capability.defaultQuality
      : undefined;
    const quality = requestedQuality || defaultQuality;
    const defaultAspectRatio = typeof capability.defaultAspectRatio === "string"
      ? capability.defaultAspectRatio
      : aspectRatios[0];
    const ratio = requestedRatio || defaultAspectRatio;

    if (!quality || !qualities.includes(quality)) {
      return res.status(requestedQuality ? 422 : 503).send({
        message: requestedQuality ? "所选图片清晰度不受当前模型支持" : "图片模型缺少可用的默认清晰度",
      });
    }
    if (!ratio || !aspectRatios.includes(ratio)) {
      return res.status(requestedRatio ? 422 : 503).send({
        message: requestedRatio ? "所选图片比例不受当前模型支持" : "图片模型缺少可用的默认比例",
      });
    }
    const imageSize = resolveVolcengineImageSize(quality, ratio);
    if (!imageSize) {
      return res.status(422).send({
        message: "所选图片清晰度与比例没有已验证的上游尺寸映射",
        code: "image_size_contract_unsupported",
      });
    }

    const subjects = Array.isArray(body.subjects) ? body.subjects : [];
    const skills = Array.isArray(body.skills) ? body.skills : [];
    const count = Number.isFinite(body.count) ? Number(body.count) : 1;
    const maxOutputs = Number.isSafeInteger(capability.maxOutputs)
      && Number(capability.maxOutputs) >= 1
      ? Number(capability.maxOutputs)
      : 1;
    if (count > maxOutputs) {
      return res.status(422).send({
        message: `所选图片模型每次最多生成 ${maxOutputs} 张`,
        code: "image_count_unsupported",
      });
    }
    if (body.targetAssetId !== undefined) {
      if (!body.projectId) {
        return res.status(422).send({ message: "更新角色或场景图片时必须指定项目" });
      }
      if (count !== 1) {
        return res.status(422).send({ message: "更新角色或场景图片时每次只能生成一张" });
      }
      const target = await db("o_assets")
        .where({
          id: body.targetAssetId,
          projectId: body.projectId,
          deletionState: "active",
        })
        .whereIn("type", ["role", "scene", "tool"])
        .select("id")
        .first();
      if (!target) {
        return res.status(404).send({ message: "角色、场景或道具资产不存在" });
      }
    }

    const subjectPrompt = subjects.length
      ? `\n主体参考：${subjects.map((item) => [item.name, item.type].filter(Boolean).join(" / ")).join("，")}`
      : "";
    const skillPrompt = skills.length ? `\n使用技能：${skills.map((item) => item.name).filter(Boolean).join("，")}` : "";
    const finalPrompt = [body.prompt, body.style ? `视觉风格：${body.style}` : "", subjectPrompt, skillPrompt].filter(Boolean).join("\n");

    if ((body.referenceImages?.length || 0) > 0) {
      return res.status(422).send({ message: "图片参考必须先上传到项目受控存储并使用 assetVersionId" });
    }
    let referenceImageUrls: string[] = [];
    let orderedReferenceAssetVersionIds: string[] = [];
    if ((body.references?.length || 0) > 0) {
      let inspectedReferences;
      try {
        inspectedReferences = await inspectGenerationReferences({
          workspaceId,
          projectId: String(body.projectId),
          references: body.references || [],
        });
      } catch (error) {
        if (error instanceof GenerationReferenceError) {
          return res.status(error.status).send({ message: error.message, code: error.code });
        }
        return res.status(500).send({ message: "图片参考素材校验失败" });
      }
      const structuralValidation = validateImageReferenceInputs(
        capability.inputSlots,
        inspectedReferences.inputs,
        inspectedReferences.providerContent,
      );
      if (!structuralValidation.ok) {
        return res.status(422).send({ message: structuralValidation.message });
      }

      let referenceContent: Record<string, unknown>[];
      try {
        referenceContent = await resolveGenerationReferences({
          workspaceId,
          projectId: String(body.projectId),
          references: body.references || [],
        });
      } catch (error) {
        if (error instanceof GenerationReferenceError) {
          return res.status(error.status).send({ message: error.message, code: error.code });
        }
        return res.status(500).send({ message: "图片参考素材校验失败" });
      }
      const validation = validateImageReferenceInputs(
        capability.inputSlots,
        inspectedReferences.inputs,
        referenceContent,
      );
      if (!validation.ok) {
        return res.status(422).send({ message: validation.message });
      }
      referenceImageUrls = validation.imageUrls;
      orderedReferenceAssetVersionIds = inspectedReferences.inputs.map((reference) =>
        String(reference.assetVersionId)
      );
    } else if (Array.isArray(capability.inputSlots) && capability.inputSlots.length > 0) {
      // 声明了 required/min 的纯图生图模型不能在缺少参考图时越过
      // capability preflight。没有 inputSlots 的文生图模型仍正常提交。
      const validation = validateImageReferenceInputs(capability.inputSlots, [], []);
      if (!validation.ok) {
        return res.status(422).send({ message: validation.message });
      }
    }
    const idempotencyKey = readRequiredIdempotencyKey(req, res);
    if (!idempotencyKey) return;

    const actorUserId = Number((req as any).auth?.user?.id || 0);
    const pricingContext = body.pricingConfirmation;
    const pricingBatchSize = pricingContext?.batchSize ?? 1;
    const pricingItemIndex = pricingContext?.itemIndex ?? 1;
    const pricingBatchIdempotencyKey = pricingContext?.batchIdempotencyKey
      ?? idempotencyKey;
    const expectedItemIdempotencyKey = pricingBatchSize === 1
      ? pricingBatchIdempotencyKey
      : `${pricingBatchIdempotencyKey}:item:${pricingItemIndex}`;
    if (
      pricingItemIndex > pricingBatchSize
      || idempotencyKey !== expectedItemIdempotencyKey
    ) {
      return res.status(409).send({
        message: "图片批次价格确认与 Idempotency-Key 不匹配",
        code: "pricing_confirmation_invalid",
      });
    }
    const pricingRequestHash = hashIdempotencyRequest({
      projectId: body.projectId ?? null,
      targetAssetId: body.targetAssetId ?? null,
      prompt: body.prompt,
      finalPrompt,
      model,
      ratio,
      quality,
      style: body.style ?? null,
      subjects,
      skills,
      references: body.references || [],
      batchSize: pricingBatchSize,
    });
    const pricingBinding: QuickCreatePricingConfirmationBinding = {
      kind: "image_batch",
      workspaceId,
      actorUserId,
      projectId: body.projectId ?? null,
      idempotencyKey: pricingBatchIdempotencyKey,
      requestHash: pricingRequestHash,
    };
    const pricingItemKeys = Array.from(
      { length: pricingBatchSize },
      (_, index) => `image:${index + 1}`,
    );
    let quickCreatePricingAuthorization: QuickCreatePricingAuthorization = {
      maximumCostMicros: pricingContext?.acceptedUnitMaximumCostMicros ?? null,
      expiresAt: null,
    };
    if (pricingContext?.token) {
      try {
        const verified = verifyQuickCreatePricingConfirmation({
          token: pricingContext.token,
          binding: pricingBinding,
          expectedItemKeys: pricingItemKeys,
        });
        quickCreatePricingAuthorization = {
          maximumCostMicros:
            verified.itemMaximumCostMicros[`image:${pricingItemIndex}`] ?? null,
          expiresAt: verified.expiresAt,
        };
      } catch (error) {
        if (error instanceof QuickCreatePricingTokenError) {
          return res.status(error.status).send({ message: error.message, code: error.code });
        }
        throw error;
      }
    }
    const sendPricingChallenge = (requiredCostMicros: number) => {
      const itemMaximumCostMicros = Object.fromEntries(
        pricingItemKeys.map((key) => [key, requiredCostMicros]),
      );
      const challenge = issueQuickCreatePricingConfirmation({
        binding: pricingBinding,
        itemMaximumCostMicros,
      });
      return res.status(409).send(quickCreatePricingChallengeBody(challenge));
    };

    if (body.targetAssetId !== undefined && body.projectId) {
      let imageTask: ProjectImageTaskReservation<QuickCreateImageCommandResult>;
      try {
        const started = await beginProjectImageTask<QuickCreateImageCommandResult>({
          workspaceId,
          actorUserId: Number((req as any).auth?.user?.id || 0),
          projectId: body.projectId,
          flow: "asset",
          scope: "workbench:create:asset-image",
          idempotencyKey,
          request: {
            projectId: body.projectId,
            targetAssetId: body.targetAssetId,
            prompt: body.prompt,
            finalPrompt,
            model,
            ratio,
            quality,
            count,
            subjects,
            skills,
            references: body.references || [],
          },
          assetId: body.targetAssetId,
          model,
          prompt: body.prompt,
          finalPrompt,
          ratio,
          quality,
          resolution: imageSize,
          requestId: String(
            (req as any).requestId || req.header("x-request-id") || "",
          ).trim() || null,
          referenceImageUrls,
          metadata: {
            subjects,
            skills,
            references: body.references || [],
          },
        });
        if (started.kind === "replay") {
          return started.responseStatus >= 200 && started.responseStatus < 300
            ? res.status(started.responseStatus).send(success(started.responseBody))
            : res.status(started.responseStatus).send(started.responseBody);
        }
        imageTask = started;
      } catch (error) {
        if (error instanceof ProjectImageTaskError) {
          return res.status(error.status).send({
            message: error.message,
            code: error.code,
            ...(error.task ? { task: error.task } : {}),
          });
        }
        throw error;
      }

      const terminalTaskResponse = () => {
        const checkpoint = imageTask.checkpoint;
        if (checkpoint.phase === "failed") {
          return res.status(checkpoint.failureStatus || 502).send({
            message: checkpoint.failureMessage || "图片生成失败",
            code: checkpoint.failureCode || "image_task_failed",
            imageTaskId: checkpoint.taskId,
          });
        }
        if (checkpoint.phase === "cancelled") {
          return res.status(409).send({
            message: checkpoint.failureMessage || "图片生成任务已取消",
            code: checkpoint.failureCode || "image_task_cancelled",
            imageTaskId: checkpoint.taskId,
          });
        }
        if (
          checkpoint.phase === "pending_reconcile"
          && !canRetryProjectImageProvider503(checkpoint)
        ) {
          return res.status(409).send({
            message: checkpoint.reconcileReason || "图片请求已派发，正在等待上游结果核对",
            code: "image_task_pending_reconcile",
            imageTaskId: checkpoint.taskId,
          });
        }
        if (checkpoint.phase === "dispatching") {
          return res.status(409).send({
            message: "相同图片生成任务正在上游处理中，请查询任务状态",
            code: "image_task_in_progress",
            imageTaskId: checkpoint.taskId,
          });
        }
        const recoveryAvailableAt = Number(
          checkpoint.metadata.recoveryAvailableAt || 0,
        );
        if (
          checkpoint.phase === "queued"
          && [PORTRAIT_PROVIDER_BINDING_PENDING_CODE, "WORKSPACE_GENERATION_QUEUED"].includes(String(checkpoint.failureCode))
          && Number.isFinite(recoveryAvailableAt)
          && recoveryAvailableAt > Date.now()
        ) {
          return res.status(409).send({
            message: checkpoint.failureMessage || "图片参考的人像资产正在准备，任务会自动重试",
            code: checkpoint.failureCode,
            imageTaskId: checkpoint.taskId,
            retryAfterMs: recoveryAvailableAt - Date.now(),
          });
        }
        return null;
      };
      const terminal = terminalTaskResponse();
      if (terminal) return terminal;

      if (imageTask.checkpoint.phase !== "provider_succeeded") {
        let claim;
        try {
          claim = await claimProjectImageTask(imageTask);
        } catch (error) {
          if (error instanceof ProjectImageTaskError) {
            return res.status(error.status).send({
              message: error.message,
              code: error.code,
              imageTaskId: imageTask.checkpoint.taskId,
            });
          }
          throw error;
        }
        imageTask = claim;
        if (claim.kind !== "claimed") {
          const response = terminalTaskResponse();
          if (response) return response;
          return res.status(409).send({
            message: "图片生成任务当前不能重复派发",
            code: "image_task_not_dispatchable",
            imageTaskId: imageTask.checkpoint.taskId,
          });
        }
        try {
          const result = await executeRelayImage(
            {
              model,
              prompt: finalPrompt,
              n: 1,
              size: imageSize,
              response_format: "url",
              ...(referenceImageUrls.length ? { image: referenceImageUrls } : {}),
            },
            {
              workspaceId,
              apiKeyId: null,
              principalId: (req as any).auth?.user?.id == null
                ? null
                : String((req as any).auth.user.id),
              requestId: imageTask.checkpoint.requestId,
              idempotencyKey: imageTask.checkpoint.providerIdempotencyKey,
              ...(orderedReferenceAssetVersionIds.length
                ? {
                    portraitReferenceScope: {
                      projectId: String(body.projectId),
                      orderedAssetVersionIds: orderedReferenceAssetVersionIds,
                      requiresPortraitAdmission: false,
                    },
                  }
                : {}),
            },
          );
          imageTask = await checkpointProjectImageProviderSuccess(
            imageTask,
            claim.claimToken,
            result.data,
          );
        } catch (error) {
          if (error instanceof WorkspaceGenerationQueued) {
            imageTask = await requeueProjectImageTask(imageTask, claim.claimToken, { status: 202, code: error.code, message: error.message,
              retryAttempt: Number(imageTask.checkpoint.metadata.bindingRetryAttempt || 0) + 1, retryAvailableAt: Date.now() + error.retryAfterMs });
            return res.status(202).send({ message: error.message, code: error.code, status: "queued",
              imageTaskId: imageTask.checkpoint.taskId, retryAfterMs: error.retryAfterMs });
          }
          if (isRetryablePortraitProviderBindingPending(error)) {
            const schedule = portraitProviderBindingRetrySchedule({
              previousAttempt: Number(
                imageTask.checkpoint.metadata.bindingRetryAttempt || 0,
              ),
            });
            imageTask = await requeueProjectImageTask(
              imageTask,
              claim.claimToken,
              {
                status: error.statusCode || 409,
                code: PORTRAIT_PROVIDER_BINDING_PENDING_CODE,
                message: "图片参考的人像资产正在准备，任务会自动重试",
                retryAttempt: schedule.attempt,
                retryAvailableAt: schedule.retryAvailableAt,
              },
            );
            return res.status(409).send({
              message: imageTask.checkpoint.failureMessage,
              code: PORTRAIT_PROVIDER_BINDING_PENDING_CODE,
              imageTaskId: imageTask.checkpoint.taskId,
              retryAfterMs: schedule.retryAfterMs,
            });
          }
          const status = error instanceof BillingError
            ? error.status
            : error instanceof RelayImageError
              ? error.statusCode || 502
              : 502;
          const message = error instanceof BillingError
            ? error.message || "图片计费失败"
            : error instanceof RelayImageError
              ? isUnsupportedPortraitImageReference(error)
                ? error.message
                : publicRelayImageError(status)
              : "图片生成失败，请重新生成";
          imageTask = await failProjectImageTask(imageTask, {
            status,
            code: isUnsupportedPortraitImageReference(error)
              ? error.reconcileReason!
              : error instanceof BillingError
                ? "image_task_billing_failed"
                : "image_task_upstream_rejected",
            message,
            pendingReconcile: false,
            retryableProvider503: false,
          });
          return res.status(status).send({
            message,
            code: imageTask.checkpoint.failureCode,
            imageTaskId: imageTask.checkpoint.taskId,
            ...(error instanceof BillingError && publicBillingErrorDetails(error)
              ? { data: publicBillingErrorDetails(error) }
              : {}),
          });
        }
      }

      const providerData = imageTask.checkpoint.providerData;
      if (!providerData?.length) {
        return res.status(500).send({
          message: "图片生成任务缺少可恢复的上游结果",
          code: "image_task_provider_result_missing",
          imageTaskId: imageTask.checkpoint.taskId,
        });
      }
      try {
        const persistedAssets = await persistGeneratedProjectImages({
          workspaceId,
          projectId: body.projectId,
          source: "quick-create",
          prompt: body.prompt,
          finalPrompt,
          model,
          ratio,
          quality,
          resolution: imageSize,
          taskIdPrefix: "quick-image",
          actorUserId: Number((req as any).auth?.user?.id || 0),
          items: providerData,
          metadata: {
            subjects,
            skills,
            projectImageTaskId: imageTask.checkpoint.taskId,
          },
          targetAssetId: body.targetAssetId,
        }, {
          database: db,
          onBeforeCommit: async (transaction, pendingAssets) => {
            const pendingPublicAssets = publicProjectImages(pendingAssets);
            await completeProjectImageTask(
              imageTask,
              {
                model,
                count: pendingPublicAssets.length,
                assets: pendingPublicAssets,
                imageTaskId: imageTask.checkpoint.taskId || undefined,
              },
              { database: transaction },
            );
          },
        });
        const assets = publicProjectImages(persistedAssets);
        return res.status(200).send(success({
          model,
          count: assets.length,
          assets,
          imageTaskId: imageTask.checkpoint.taskId || undefined,
        }));
      } catch {
        return res.status(500).send({
          message: "图片结果保存失败，可使用相同 Idempotency-Key 安全恢复；不会重复调用上游或扣费",
          code: "image_task_persistence_retryable",
          imageTaskId: imageTask.checkpoint.taskId,
        });
      }
    }

    const commandScope = "workbench:create:images";
    const commandScopeKey = `${commandScope}:${workspaceId}:${actorUserId}`;
    const commandRequest = {
      projectId: body.projectId ?? null,
      targetAssetId: body.targetAssetId ?? null,
      prompt: body.prompt,
      finalPrompt,
      model,
      ratio,
      quality,
      count,
      subjects,
      skills,
      references: body.references || [],
    };
    const commandRequestHash = hashIdempotencyRequest(commandRequest);
    if (candidateEFormalProjectNotFound(res, body.projectId ?? null)) return;
    let candidateEFailpoint: CandidateESettledImageAuthorization | null = null;
    try {
      candidateEFailpoint = authorizeCandidateESettledImageFailpoint({
        capabilityHeader: req.header(CANDIDATE_E_SETTLED_IMAGE_FAILPOINT_HEADER),
        armingFileHeader: req.header(CANDIDATE_E_SETTLED_IMAGE_ARMING_HEADER),
        acknowledgementProofHeader: req.header(CANDIDATE_E_SETTLED_IMAGE_ACK_HEADER),
        formalRuntimeSession: candidateEFormalRuntimeSession(res),
        formalExactAuthorizationTrustEnvironment:
          formalCandidateESurface(res)?.exactAuthorizationTrustEnvironment,
        request: {
          workspaceId,
          actorUserId,
          projectId: body.projectId ?? null,
          idempotencyKey,
          requestHash: commandRequestHash,
          model,
          count,
        },
      });
    } catch (error) {
      if (error instanceof CandidateESettledImageFailpointError) {
        return res.status(error.status).send({
          message: "Candidate E 已结算图片故障演练未通过精确授权绑定",
          code: error.code,
        });
      }
      throw error;
    }
    let commandReservation: DurableCommandReservation<QuickCreateImageCommandResponse>;
    try {
      if (checkpointMaterializeOnly) {
        const rows = await db("o_agent_idempotency")
          .where({
            workspaceId,
            actorUserId,
            scopeKey: commandScopeKey,
            idempotencyKey,
            requestHash: commandRequestHash,
            resourceType: "workbench_generation_command",
          })
          .whereNull("resourceId")
          .select("id", "status", "responseStatus", "responseBody")
          .limit(2);
        if (
          rows.length !== 1
          || typeof rows[0].responseBody !== "string"
          || !rows[0].responseBody.trim()
        ) {
          return res.status(409).send({
            message: "图片检查点不存在或当前状态不允许素材化",
            code: "image_checkpoint_materialize_precondition_failed",
          });
        }
        if (String(rows[0].status || "") === "completed") {
          if (
            !recoveryCapabilityBound
            || Number(rows[0].responseStatus || 0) !== 200
            || !body.projectId
          ) {
            return res.status(409).send({
              message: "图片素材化完成态缺少精确恢复能力",
              code: "image_checkpoint_materialize_precondition_failed",
            });
          }
          const completed = await attestCandidateECompletedImageMaterialization({
            commandId: String(rows[0].id),
            workspaceId,
            actorUserId,
            scopeKey: commandScopeKey,
            idempotencyKey,
            requestHash: commandRequestHash,
            projectId: body.projectId,
            model,
            ratio,
            quality,
            resolution: imageSize,
            prompt: body.prompt,
          });
          if (!completed) {
            return res.status(409).send({
              message: "图片素材化完成态无法通过耐久资产指纹对账",
              code: "image_checkpoint_materialize_reconciliation_failed",
            });
          }
          try {
            activateCandidateESettledImageRecoveryCapability(req);
            commitCandidateESettledImageRecoveryCapability(req, {
              materializedAssets: 1,
              proof: completed.proof,
            });
            return res.status(200).send(success(completed.response));
          } catch (error) {
            if (error instanceof CandidateESettledImageRecoveryError) {
              const conflict = [
                "CANDIDATE_E_IMAGE_RECOVERY_IN_PROGRESS",
                "CANDIDATE_E_IMAGE_RECOVERY_ALREADY_SUCCEEDED",
              ].includes(error.code);
              return res.status(conflict ? 409 : 500).send({
                message: conflict
                  ? "Candidate E 图片恢复正在执行或已经完成"
                  : "Candidate E 图片恢复状态无法安全提交",
                code: conflict
                  ? "candidate_e_recovery_conflict"
                  : "candidate_e_recovery_state_failed",
              });
            }
            throw error;
          } finally {
            finalizeCandidateESettledImageRecoveryExecution(req);
          }
        }
        if (String(rows[0].status || "") !== "checkpointed") {
          return res.status(409).send({
            message: "图片检查点不存在或当前状态不允许素材化",
            code: "image_checkpoint_materialize_precondition_failed",
          });
        }
        let checkpoint: unknown;
        try {
          checkpoint = JSON.parse(rows[0].responseBody);
        } catch {
          return res.status(409).send({
            message: "图片检查点内容无效",
            code: "image_checkpoint_materialize_precondition_failed",
          });
        }
        commandReservation = {
          kind: "resume",
          id: String(rows[0].id),
          checkpoint,
        };
      } else {
        commandReservation = await beginDurableCommand<QuickCreateImageCommandResponse>({
          workspaceId,
          actorUserId,
          scope: commandScope,
          idempotencyKey,
          request: commandRequest,
        });
      }
      if (commandReservation.kind === "replay") {
        if (candidateEFailpoint) {
          return res.status(403).send({
            message: "Candidate E 故障演练只允许新建的唯一付费命令",
            code: "candidate_e_existing_command_forbidden",
          });
        }
        if (checkpointMaterializeOnly) {
          return res.status(409).send({
            message: "图片检查点已经完成，不能再次素材化",
            code: "image_checkpoint_materialize_terminal",
          });
        }
        return commandReservation.responseStatus >= 400
          ? res
              .status(commandReservation.responseStatus)
              .send(commandReservation.responseBody)
          : res
              .status(commandReservation.responseStatus)
              .send(success(commandReservation.responseBody));
      }
      if (candidateEFailpoint && commandReservation.kind !== "reserved") {
        return res.status(403).send({
          message: "Candidate E 故障演练不允许恢复态命令再次派发",
          code: "candidate_e_existing_command_forbidden",
        });
      }
    } catch (error) {
      if (error instanceof DurableCommandIdempotencyError) {
        return res.status(error.status).send({ message: error.message, code: error.code });
      }
      throw error;
    }

    let candidateEOperationClaim: CandidateEOperationClaim | null = null;
    let candidateECommandIdentity: CandidateESettledImageCommandIdentity | null = null;
    if (candidateEFailpoint && commandReservation.kind === "reserved") {
      candidateECommandIdentity = {
        id: commandReservation.id,
        workspaceId,
        actorUserId,
        scopeKey: commandScopeKey,
        idempotencyKey,
        requestHash: commandRequestHash,
      };
      try {
        candidateEOperationClaim = await acquireCandidateESettledImageOperationClaim(
          candidateEFailpoint,
          candidateECommandIdentity,
          db,
        );
      } catch (error) {
        if (error instanceof CandidateESettledImageFailpointError) {
          await abandonDurableCommand(commandReservation).catch(() => undefined);
          return res.status(error.status).send({
            message: "Candidate E 付费操作已被其他耐久命令占用或精确授权已失效",
            code: error.code,
          });
        }
        throw error;
      }
    }

    let providerCheckpoint = commandReservation.kind === "resume"
      ? providerCheckpointData(commandReservation.checkpoint)
      : null;
    let providerCheckpointAvailable = providerCheckpoint !== null;
    let billingSettlementConfirmed = providerCheckpoint?.settlementState === "settled";
    if (
      checkpointMaterializeOnly
      && (
        commandReservation.kind !== "resume"
        || !providerCheckpoint
        || providerCheckpoint.settlementState !== "settled"
        || providerCheckpoint.data.length !== count
      )
    ) {
      return res.status(409).send({
        message: "图片检查点不满足仅素材化恢复条件",
        code: "image_checkpoint_materialize_precondition_failed",
      });
    }
    if (
      checkpointMaterializeOnly
      && !(
        providerCheckpoint?.billing
        && await hasClosedImageSettlement(
          providerCheckpoint.billing,
          providerCheckpoint.data.length,
          {
            id: commandReservation.kind === "resume"
              ? commandReservation.id
              : "",
            workspaceId,
            actorUserId,
            scopeKey: commandScopeKey,
            idempotencyKey,
            requestHash: commandRequestHash,
          },
        )
      )
    ) {
      return res.status(409).send({
        message: "图片检查点缺少闭合的客户结算凭据",
        code: "image_checkpoint_materialize_precondition_failed",
      });
    }
    try {
      let providerData = providerCheckpoint?.data || null;
      const retryableDispatchCheckpoint = commandReservation.kind === "resume"
        ? dispatchCheckpointData(commandReservation.checkpoint)
        : null;
      const canRetryProvider503 = retryableDispatchCheckpoint?.retryableProvider503 === true;
      if (commandReservation.kind === "resume" && !providerData) {
        const rawCheckpointVersion = commandReservation.checkpoint
          && typeof commandReservation.checkpoint === "object"
          && !Array.isArray(commandReservation.checkpoint)
          ? String((commandReservation.checkpoint as Record<string, unknown>).version || "")
          : "";
        if (
          (retryableDispatchCheckpoint && !canRetryProvider503)
          || rawCheckpointVersion.startsWith("quick-create-image-provider.")
        ) {
          return res.status(409).send(
            retryableDispatchCheckpoint
              ? {
                  ...pendingDispatchReconcileBody(),
                  ...(retryableDispatchCheckpoint.pendingMessage
                    ? { message: retryableDispatchCheckpoint.pendingMessage } : {}),
                  ...(retryableDispatchCheckpoint.pendingUpstreamStatus
                    ? { upstreamStatus: retryableDispatchCheckpoint.pendingUpstreamStatus } : {}),
                }
              : {
                  message: "图片请求已发出，暂未确认结果；费用记录可在账单中查询，不会自动重复提交",
                  code: "image_task_pending_reconcile",
                } satisfies QuickCreateImageCommandError,
          );
        }
        throw new DurableCommandIdempotencyError(
          500,
          "idempotency_checkpoint_invalid",
          "图片生成恢复检查点无效",
        );
      }
      const persistProviderCheckpoint = async (
        nextCheckpoint: QuickCreateImageProviderCheckpoint,
      ): Promise<void> => {
        if (commandReservation.kind === "reserved") {
          const checkpointed = await checkpointDurableCommand<
            QuickCreateImageCommandResponse,
            QuickCreateImageCheckpoint
          >(commandReservation, nextCheckpoint);
          if (checkpointed.kind !== "resume") {
            throw new DurableCommandIdempotencyError(
              409,
              "idempotency_checkpoint_conflict",
              "图片生成恢复检查点状态已变化，请刷新任务状态",
            );
          }
          commandReservation = checkpointed;
        } else if (commandReservation.kind === "resume") {
          const checkpointed = await mutateDurableCommandCheckpoint<
            QuickCreateImageCommandResponse,
            QuickCreateImageCheckpoint
          >(
            commandReservation,
            (currentCheckpoint) => {
              if (!dispatchCheckpointData(currentCheckpoint)) {
                throw new DurableCommandIdempotencyError(
                  409,
                  "idempotency_checkpoint_conflict",
                  "图片生成派发检查点状态已变化，请刷新任务状态",
                );
              }
              return nextCheckpoint;
            },
          );
          if (checkpointed.kind !== "resume") {
            throw new DurableCommandIdempotencyError(
              409,
              "idempotency_checkpoint_conflict",
              "图片生成命令已由其他请求完成，请刷新任务状态",
            );
          }
          commandReservation = checkpointed;
        } else {
          throw new DurableCommandIdempotencyError(
            409,
            "idempotency_checkpoint_conflict",
            "图片生成命令当前不能写入恢复检查点",
          );
        }
        providerCheckpoint = nextCheckpoint;
        providerCheckpointAvailable = true;
        billingSettlementConfirmed = nextCheckpoint.settlementState === "settled";
      };
      const confirmProviderSettlement = async (): Promise<void> => {
        if (!providerCheckpoint) {
          throw new DurableCommandIdempotencyError(
            500,
            "idempotency_checkpoint_invalid",
            "图片生成结果缺少结算恢复检查点",
          );
        }
        if (providerCheckpoint.settlementState === "settled") {
          billingSettlementConfirmed = true;
          return;
        }
        const checkpointed = await mutateDurableCommandCheckpoint<
          QuickCreateImageCommandResponse,
          QuickCreateImageCheckpoint
        >(
          commandReservation,
          (currentCheckpoint) => {
            const currentProviderCheckpoint = providerCheckpointData(currentCheckpoint);
            if (!currentProviderCheckpoint) {
              throw new DurableCommandIdempotencyError(
                409,
                "idempotency_checkpoint_conflict",
                "图片生成结果结算检查点状态已变化，请刷新任务状态",
              );
            }
            return {
              ...currentProviderCheckpoint,
              settlementState: "settled",
            };
          },
        );
        if (checkpointed.kind !== "resume") {
          throw new DurableCommandIdempotencyError(
            409,
            "idempotency_checkpoint_conflict",
            "图片生成命令已由其他请求完成，请刷新任务状态",
          );
        }
        commandReservation = checkpointed;
        providerCheckpoint = providerCheckpointData(checkpointed.checkpoint);
        if (!providerCheckpoint || providerCheckpoint.settlementState !== "settled") {
          throw new DurableCommandIdempotencyError(
            500,
            "idempotency_checkpoint_invalid",
            "图片生成结果结算检查点更新失败",
          );
        }
        providerCheckpointAvailable = true;
        billingSettlementConfirmed = true;
      };

      if (providerCheckpoint?.settlementState === "pending") {
        const settlementClosed = providerCheckpoint.billing
          ? await hasClosedImageSettlement(
              providerCheckpoint.billing,
              providerCheckpoint.data.length,
            )
          : false;
        if (!settlementClosed) {
          return res.status(409).send({
            message: "图片上游结果已保存，但客户结算尚未得到闭合凭据；已转入对账且不会交付或重复派发",
            code: "image_task_pending_reconcile",
          } satisfies QuickCreateImageCommandError);
        }
        await confirmProviderSettlement();
        providerData = providerCheckpoint.data;
      }
      if (!providerData) {
        if (checkpointMaterializeOnly) {
          return res.status(409).send({
            message: "图片检查点缺少已结算的上游结果",
            code: "image_checkpoint_materialize_precondition_failed",
          });
        }
        if (commandReservation.kind !== "reserved" && !canRetryProvider503) {
          throw new DurableCommandIdempotencyError(
            409,
            "idempotency_checkpoint_conflict",
            "图片生成命令当前不能再次派发",
          );
        }
        const dispatchCommand = commandReservation;
        if (dispatchCommand.kind === "disabled") {
          throw new DurableCommandIdempotencyError(
            409,
            "idempotency_checkpoint_conflict",
            "图片生成命令当前不能再次派发",
          );
        }
        const dispatchCommandId = dispatchCommand.id;
        let pendingDispatchCheckpoint: QuickCreateImageDispatchCheckpoint | null = null;
        const result = await executeRelayImage(
          {
            model,
            prompt: finalPrompt,
            n: count,
            size: imageSize,
            response_format: "url",
            ...(referenceImageUrls.length ? { image: referenceImageUrls } : {}),
          },
          {
            workspaceId,
            apiKeyId: null,
            principalId: (req as any).auth?.user?.id == null ? null : String((req as any).auth.user.id),
            requestId: String((req as any).requestId || req.header("x-request-id") || "").trim() || null,
            idempotencyKey,
            ...(orderedReferenceAssetVersionIds.length
              ? {
                  portraitReferenceScope: {
                    projectId: String(body.projectId),
                    orderedAssetVersionIds: orderedReferenceAssetVersionIds,
                    requiresPortraitAdmission: false,
                  },
                }
              : {}),
            durableCommandIdentity: {
              contractVersion: "workbench-generation-command.v1",
              commandId: dispatchCommandId,
              workspaceId,
              actorUserId,
              scopeKey: commandScopeKey,
              idempotencyKey,
              requestHash: commandRequestHash,
            },
            requireQuickCreatePricingConfirmation: true,
            quickCreatePricingAuthorization,
            onBeforeProviderDispatchCommit: async (boundary, transaction) => {
              if (candidateEFailpoint) {
                if (!candidateEOperationClaim || !candidateECommandIdentity) {
                  throw new CandidateESettledImageFailpointError(
                    "candidate_e_operation_claim_missing",
                  );
                }
                await assertCandidateESettledImageDispatchAndAcquireGuard(
                  candidateEFailpoint,
                  transaction,
                  boundary,
                  candidateECommandIdentity,
                  candidateEOperationClaim,
                );
              }
              const checkpoint = {
                version: "quick-create-image-dispatch.v1",
                reservationId: boundary.reservationId,
                requestId: boundary.requestId,
                provider: boundary.provider,
                channelId: boundary.channelId,
                reconcileJobId: boundary.reconcileJobId,
                dispatchStartedAt: boundary.dispatchStartedAt,
                dispatchWatchdogAt: boundary.dispatchWatchdogAt,
              } satisfies QuickCreateImageDispatchCheckpoint;
              const checkpointed = dispatchCommand.kind === "reserved"
                ? await checkpointDurableCommand<
                    QuickCreateImageCommandResponse,
                    QuickCreateImageCheckpoint
                  >(
                    dispatchCommand,
                    checkpoint,
                    { database: transaction },
                  )
                : await mutateDurableCommandCheckpoint<
                    QuickCreateImageCommandResponse,
                    QuickCreateImageCheckpoint
                  >(
                    dispatchCommand,
                    (currentCheckpoint) => {
                      const currentDispatch = dispatchCheckpointData(currentCheckpoint);
                      if (!currentDispatch?.retryableProvider503) {
                        throw new DurableCommandIdempotencyError(
                          409,
                          "idempotency_checkpoint_conflict",
                          "图片生成恢复检查点状态已变化，请刷新任务状态",
                        );
                      }
                      return checkpoint;
                    },
                    { database: transaction },
                  );
              if (checkpointed.kind !== "resume") {
                throw new DurableCommandIdempotencyError(
                  409,
                  "idempotency_checkpoint_conflict",
                  "图片生成派发意图未能写入恢复检查点",
                );
              }
              pendingDispatchCheckpoint = checkpoint;
            },
            onProviderDispatchCommitted: () => {
              if (!pendingDispatchCheckpoint) return;
              commandReservation = {
                kind: "resume",
                id: dispatchCommandId,
                checkpoint: pendingDispatchCheckpoint,
              };
            },
            onProviderResult: async (providerResult, billingCheckpoint) => {
              await persistProviderCheckpoint({
                version: "quick-create-image-provider.v2",
                data: providerResult.data,
                ...(providerResult.usage ? { usage: providerResult.usage } : {}),
                billing: billingCheckpoint,
                settlementState: "pending",
              });
            },
          },
        );
        providerData = result.data;
        // Test doubles and legacy internal callers may not invoke lifecycle
        // hooks. Preserve their recovery behavior without weakening the real
        // provider path, whose result checkpoint is written before settlement.
        if (!providerCheckpointAvailable) {
          await persistProviderCheckpoint({
            version: "quick-create-image-provider.v2",
            data: providerData,
            ...(result.usage ? { usage: result.usage } : {}),
            billing: null,
            settlementState: "settled",
          });
        } else {
          // executeRelayImage returns only after settlement succeeds. Record
          // that transition before any customer-visible asset is committed.
          await confirmProviderSettlement();
        }
      }

      if (candidateEFailpoint) {
        if (!body.projectId) {
          throw new DurableCommandIdempotencyError(
            500,
            "candidate_e_project_scope_required",
            "Candidate E 故障演练必须绑定受控项目",
          );
        }
        const closed = providerCheckpoint?.billing
          ? await hasClosedImageSettlement(
              providerCheckpoint.billing,
              providerCheckpoint.data.length,
              {
                id: "id" in commandReservation ? commandReservation.id : "",
                workspaceId,
                actorUserId,
                scopeKey: commandScopeKey,
                idempotencyKey,
                requestHash: commandRequestHash,
              },
            )
          : false;
        if (!closed) {
          throw new DurableCommandIdempotencyError(
            500,
            "candidate_e_settlement_proof_incomplete",
            "Candidate E 图片已结算检查点缺少闭合账务凭据",
          );
        }
        triggerCandidateESettledImageFailpoint(
          candidateEFailpoint,
          providerCheckpoint,
        );
      }

      if (checkpointMaterializeOnly && recoveryCapabilityBound) {
        // Every authentication, RBAC, request, idempotency, provider-checkpoint
        // and closed-settlement precondition has succeeded. Acquire the
        // request-local single-operation capability only at the materialization
        // commit boundary; any earlier 4xx/5xx leaves the ticket reusable.
        activateCandidateESettledImageRecoveryCapability(req);
      }

      const generationTraceMetadata =
        "id" in commandReservation && commandReservation.id
          ? {
              generationCommandId: commandReservation.id,
              generationRequestHash: commandRequestHash,
              generationIdempotencyKey: idempotencyKey,
            }
          : {};
      let assets: Array<Record<string, unknown>>;
      if (body.projectId) {
        const persistedAssets = await persistGeneratedProjectImages({
            workspaceId,
            projectId: body.projectId,
            source: "quick-create",
            prompt: body.prompt,
            finalPrompt,
            model,
            ratio,
            quality,
            resolution: imageSize,
            taskIdPrefix: "quick-image",
            actorUserId,
            items: providerData,
            metadata: {
              subjects,
              skills,
              ...generationTraceMetadata,
            },
            ...(body.targetAssetId !== undefined
              ? { targetAssetId: body.targetAssetId }
              : {}),
          }, {
            database: db,
            onBeforeCommit: async (transaction, pendingAssets) => {
              const pendingPublicAssets = publicProjectImages(pendingAssets);
              await completeDurableCommand(
                commandReservation,
                {
                  model,
                  count: pendingPublicAssets.length,
                  assets: pendingPublicAssets,
                },
                200,
                {
                  database: transaction,
                  completedRetentionMs: TRUSTED_GENERATED_IMAGE_COMMAND_RETENTION_MS,
                },
              );
            },
          });
        assets = publicProjectImages(persistedAssets);
      } else {
        const inspirationProject = await ensureInspirationWorkspaceProject({
          database: db,
          workspaceId,
          userId: actorUserId,
          imageModel: model,
          imageQuality: quality,
          videoRatio: ratio,
        });
        const persistedAssets = await persistGeneratedProjectImages({
          workspaceId,
          projectId: inspirationProject.id,
          source: "quick-create",
          prompt: body.prompt,
          finalPrompt,
          model,
          ratio,
          quality,
          resolution: imageSize,
          taskIdPrefix: "quick-image",
          actorUserId,
          items: providerData,
          metadata: {
            subjects,
            skills,
            ...generationTraceMetadata,
          },
        }, {
          database: db,
          onBeforeCommit: async (transaction, pendingAssets) => {
            const pendingPublicAssets = publicProjectImages(pendingAssets);
            await completeDurableCommand(
              commandReservation,
              {
                model,
                count: pendingPublicAssets.length,
                assets: pendingPublicAssets,
              },
              200,
              { database: transaction },
            );
          },
        });
        assets = publicProjectImages(persistedAssets);
      }

      if (checkpointMaterializeOnly && recoveryCapabilityBound) {
        if (assets.length !== 1) {
          throw new DurableCommandIdempotencyError(
            500,
            "image_checkpoint_materialize_result_invalid",
            "图片检查点素材化结果数量无效",
          );
        }
        if (!body.projectId || !("id" in commandReservation)) {
          throw new DurableCommandIdempotencyError(
            500,
            "image_checkpoint_materialize_reconciliation_failed",
            "图片素材化完成态缺少耐久命令身份",
          );
        }
        const completed = await attestCandidateECompletedImageMaterialization({
          commandId: commandReservation.id,
          workspaceId,
          actorUserId,
          scopeKey: commandScopeKey,
          idempotencyKey,
          requestHash: commandRequestHash,
          projectId: body.projectId,
          model,
          ratio,
          quality,
          resolution: imageSize,
          prompt: body.prompt,
        });
        if (!completed) {
          throw new DurableCommandIdempotencyError(
            500,
            "image_checkpoint_materialize_reconciliation_failed",
            "图片素材化完成态无法通过耐久资产指纹对账",
          );
        }
        commitCandidateESettledImageRecoveryCapability(req, {
          materializedAssets: 1,
          proof: completed.proof,
        });
      }
      const responseBody = { model, count: assets.length, assets };
      return res.status(200).send(success(responseBody));
    } catch (err: any) {
      if (
        candidateEFailpoint
        && candidateEOperationClaim
        && candidateECommandIdentity
      ) {
        await releaseCandidateESettledImageOperationClaimIfSafe(
          candidateEFailpoint,
          candidateEOperationClaim,
          candidateECommandIdentity,
          db,
        ).catch(() => false);
      }
      if (err instanceof CandidateESettledImageRecoveryError) {
        const conflict = [
          "CANDIDATE_E_IMAGE_RECOVERY_IN_PROGRESS",
          "CANDIDATE_E_IMAGE_RECOVERY_ALREADY_SUCCEEDED",
        ].includes(err.code);
        return res.status(conflict ? 409 : 500).send({
          message: conflict
            ? "Candidate E 图片恢复正在执行或已经完成"
            : "Candidate E 图片恢复状态无法安全提交",
          code: conflict
            ? "candidate_e_recovery_conflict"
            : "candidate_e_recovery_state_failed",
        });
      }
      if (err instanceof CandidateESettledImageInjectedFailure) {
        return res.status(err.status).send({
          message: "Candidate E 已在结算检查点后、素材化前中断；仅可执行零上游恢复",
          code: err.code,
          // `code` is intentionally redacted on HTTP 500 responses by the global
          // error middleware. Keep a non-sensitive, stable discriminator so the
          // drill remains externally recognizable without weakening redaction.
          failureKind: err.code,
        });
      }
      if (err instanceof CandidateESettledImageFailpointError) {
        if (providerCheckpointAvailable || billingSettlementConfirmed) {
          return res.status(500).send({
            message: "Candidate E 已有上游结果或结算凭据，已保留检查点且禁止重派发",
            code: "candidate_e_post_settlement_recovery_required",
            failureKind: "candidate_e_post_settlement_recovery_required",
            reason: err.code,
          });
        }
        await abandonDurableCommand(commandReservation).catch(() => undefined);
        return res.status(err.status).send({
          message: "Candidate E 付费图片调用在上游派发前被安全拒绝",
          code: err.code,
        });
      }
      if (providerCheckpointAvailable && !billingSettlementConfirmed) {
        return res.status(409).send({
          message: "图片上游结果已保存，但客户结算尚未得到闭合凭据；已转入对账且不会交付或重复派发",
          code: "image_task_pending_reconcile",
        } satisfies QuickCreateImageCommandError);
      }
      if (err instanceof DurableCommandIdempotencyError) {
        return res.status(err.status).send({ message: err.message, code: err.code });
      }
      if (providerCheckpointAvailable) {
        return res.status(500).send({
          message: "图片结果保存失败，可使用相同 Idempotency-Key 安全恢复；不会重复调用上游或扣费",
          code: "image_task_persistence_retryable",
        });
      }
      const dispatchCheckpoint = commandReservation.kind === "resume"
        ? dispatchCheckpointData(commandReservation.checkpoint)
        : null;
      if (dispatchCheckpoint) {
        if (err instanceof RelayImageError && !err.upstreamMayHaveAccepted) {
          const status = err.statusCode || 502;
          const rejectedBody: QuickCreateImageCommandError = {
            message: isUnsupportedPortraitImageReference(err)
              ? err.message
              : publicRelayImageError(status),
            code: isUnsupportedPortraitImageReference(err)
              ? err.reconcileReason!
              : "image_task_upstream_rejected",
          };
          await completeDurableCommand(commandReservation, rejectedBody, status)
            .catch(() => undefined);
          return res.status(status).send(rejectedBody);
        }
        if (shouldRetryIdempotentImageRequest(err)) {
          const checkpointed = await mutateDurableCommandCheckpoint<
            QuickCreateImageCommandResponse,
            QuickCreateImageCheckpoint
          >(
            commandReservation,
            (currentCheckpoint) => {
              const currentDispatch = dispatchCheckpointData(currentCheckpoint);
              if (!currentDispatch) {
                throw new DurableCommandIdempotencyError(
                  409,
                  "idempotency_checkpoint_conflict",
                  "图片生成恢复检查点状态已变化，请刷新任务状态",
                );
              }
              return { ...currentDispatch, retryableProvider503: true };
            },
          );
          if (checkpointed.kind === "resume") commandReservation = checkpointed;
          return res.status(409).send({
            ...pendingDispatchReconcileBody(err),
            message: "图片服务暂时不可用；可使用原请求安全重试，不会创建新订单或重复确认费用",
            code: "image_task_retryable_provider_503",
          } satisfies QuickCreateImageCommandError);
        }
        const pendingBody = pendingDispatchReconcileBody(err);
        await mutateDurableCommandCheckpoint<
          QuickCreateImageCommandResponse,
          QuickCreateImageCheckpoint
        >(commandReservation, (currentCheckpoint) => {
          const currentDispatch = dispatchCheckpointData(currentCheckpoint);
          if (!currentDispatch) {
            throw new DurableCommandIdempotencyError(
              409, "idempotency_checkpoint_conflict", "图片请求状态已变化，请查询原请求",
            );
          }
          return { ...currentDispatch, pendingMessage: pendingBody.message,
            ...(err instanceof RelayImageError ? { pendingUpstreamStatus: err.statusCode } : {}) };
        });
        console.warn("[quickCreateImage] dispatch outcome pending", {
          requestId: dispatchCheckpoint.requestId,
          upstreamStatus: err instanceof RelayImageError ? err.statusCode : null,
          reason: err instanceof RelayImageError ? err.reconcileReason : null,
          upstreamMessage: err instanceof RelayImageError ? redactSensitiveText(err.message).slice(0, 1000) : null,
          upstreamCode: err instanceof RelayImageError ? err.reconciliationMetadata.upstreamCode : null,
          upstreamType: err instanceof RelayImageError ? err.reconciliationMetadata.upstreamType : null,
        });
        return res.status(409).send(pendingBody);
      }
      if (err instanceof BillingError) {
        await abandonDurableCommand(commandReservation).catch(() => undefined);
        if (err instanceof QuickCreatePricingConfirmationError) {
          return sendPricingChallenge(err.requiredCostMicros);
        }
        return res.status(err.status).send({
          message: err.message || "图片计费失败",
          code: "image_task_billing_failed",
          ...(publicBillingErrorDetails(err)
            ? { data: publicBillingErrorDetails(err) }
            : {}),
        });
      }
      if (err instanceof RelayImageError) {
        const status = err.statusCode || 502;
        if (!err.upstreamMayHaveAccepted) {
          await abandonDurableCommand(commandReservation).catch(() => undefined);
          return res.status(status).send({
            message: isUnsupportedPortraitImageReference(err)
              ? err.message
              : publicRelayImageError(status),
            code: isUnsupportedPortraitImageReference(err)
              ? err.reconcileReason
              : "image_task_upstream_rejected",
          });
        }
        const pendingBody: QuickCreateImageCommandError = {
          message: "图片请求可能已由上游接收，正在等待结果核对；系统不会自动重发或重复扣费",
          code: "image_task_pending_reconcile",
          deliveryTraceVersion:
            QUICK_CREATE_IMAGE_NO_DELIVERY_TRACE_VERSION,
        };
        await completeDurableCommand(
          commandReservation,
          pendingBody,
          409,
        ).catch(() => undefined);
        return res.status(409).send(pendingBody);
      }
      const pendingBody: QuickCreateImageCommandError = {
        message: "图片请求状态无法确认，正在等待结果核对；系统不会自动重发或重复扣费",
        code: "image_task_pending_reconcile",
        deliveryTraceVersion:
          QUICK_CREATE_IMAGE_NO_DELIVERY_TRACE_VERSION,
      };
      await completeDurableCommand(
        commandReservation,
        pendingBody,
        409,
      ).catch(() => undefined);
      return res.status(409).send(pendingBody);
    } finally {
      if (recoveryCapabilityBound) {
        finalizeCandidateESettledImageRecoveryExecution(req);
      }
    }
  },
);
