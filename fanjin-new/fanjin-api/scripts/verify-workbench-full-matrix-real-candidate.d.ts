import { type CandidateAcceptanceSession, type CandidateHttpRequest, type CandidateHttpResponse } from "./verify-workbench-real-candidate";
import { FULL_MATRIX_MANIFEST_VERSION } from "./lib/full-matrix-session-binding";
import { type CandidateExactAuthorizationAbsorbedOperationProof, type CandidateExactAuthorizationConsumption, type CandidateExactAuthorizationLiveReadbackProof } from "./lib/candidate-exact-authorization-v2";
export { FULL_MATRIX_MANIFEST_VERSION, fullMatrixSessionBinding, } from "./lib/full-matrix-session-binding";
export declare const FULL_MATRIX_PAID_FLAG = "--paid-full-matrix";
export declare const FULL_MATRIX_PREFLIGHT_FLAG = "--preflight-only";
export declare const FULL_MATRIX_RECONCILE_FLAG = "--reconcile-only";
export declare const FULL_MATRIX_NEGATIVE_GATES_FLAG = "--negative-gates-only";
export declare const FULL_MATRIX_RESUME_FLAG = "--resume";
export declare const FULL_MATRIX_AUTHORIZATION_SEGMENT_INDEX_FLAG = "--authorization-segment-index";
export declare const FULL_MATRIX_AUTHORIZATION_SEGMENT_LIMIT_FLAG = "--authorization-segment-limit";
export declare const FULL_MATRIX_ABSORBED_CONTINUATION_FLAG = "--resume-after-absorbed-no-delivery";
export declare const FULL_MATRIX_ACK_ENV = "FANJIN_REAL_FULL_MATRIX_ACK";
export declare const FULL_MATRIX_ACK_VALUE = "I_ACCEPT_EXACTLY_41_REAL_UPSTREAM_REQUESTS_FULL_MATRIX_NO_AUTOMATIC_RETRY";
export declare const FULL_MATRIX_ABSORBED_CONTINUATION_ACK_ENV = "FANJIN_REAL_FULL_MATRIX_ABSORBED_CONTINUATION_ACK";
export declare const FULL_MATRIX_ABSORBED_CONTINUATION_ACK_VALUE = "I_ACCEPT_42_SUBMISSIONS_41_SUCCESSES_1_ABSORBED_HTTP400_CUSTOMER_CAP_200K_GU_PLATFORM_CAP_92K_GU_GROSS_CAP_292K_GU_NO_AUTOMATIC_RETRY";
export declare const FULL_MATRIX_NEGATIVE_GATES_ACK_ENV = "FANJIN_REAL_NEGATIVE_GATES_ACK";
export declare const FULL_MATRIX_NEGATIVE_GATES_ACK_VALUE = "I_ACCEPT_EXACTLY_2_REJECTED_PRE_DISPATCH_REQUESTS_ZERO_UPSTREAM";
export declare const FULL_MATRIX_NEGATIVE_GATES_EVIDENCE_VERSION = "fanjin-workbench-negative-gates-evidence/v1";
export declare const FULL_MATRIX_NEGATIVE_GATES_REQUEST_COUNT = 2;
export declare const FULL_MATRIX_CALL_LIMIT = 41;
export declare const FULL_MATRIX_CONTINUATION_ATTEMPT_LIMIT = 42;
export declare const FULL_MATRIX_PAID_GUARD_SUFFIX = ".paid-full-matrix.started";
export declare const FULL_MATRIX_AUTHORIZATION_LINEAGE_SUFFIX = ".paid-full-matrix.authorization-lineage";
export declare const FULL_MATRIX_AUTHORIZATION_SEGMENT_GUARD_PREFIX = ".paid-full-matrix.authorization-segment.";
export declare const FULL_MATRIX_AUTHORIZATION_RENEWAL_MARGIN_MS = 30000;
export declare const FULL_MATRIX_ABSORBED_CONTINUATION_GUARD_SUFFIX = ".paid-full-matrix.absorbed-continuation.started";
export declare const FULL_MATRIX_PLAN_VERSION = "fanjin-workbench-full-matrix-plan/v4";
export declare const FULL_MATRIX_SPEND_STOP_MICROS = 200000000000;
export declare const FULL_MATRIX_PLATFORM_ABSORBED_STOP_MICROS = 92000000000;
export declare const FULL_MATRIX_GROSS_EXPOSURE_STOP_MICROS = 292000000000;
export declare const FULL_MATRIX_MAX_IMAGE_BYTES: number;
export declare const FULL_MATRIX_MAX_VIDEO_BYTES: number;
export declare const FULL_MATRIX_MIN_VIDEO_DEADLINE_MS = 300000;
export declare const FULL_MATRIX_OMNI_REFERENCE_VIDEO_COUNT = 2;
export declare const FULL_MATRIX_CONTINUATION_OMNI_REFERENCE_IMAGE_COUNT = 1;
export declare const FULL_MATRIX_OMNI_REFERENCE_VIDEO_DURATION_SECONDS: readonly [5, 4];
export declare const FULL_MATRIX_OMNI_REFERENCE_VIDEO_DURATION_LIMIT_SECONDS = 15.2;
export declare const FULL_MATRIX_IMAGE_RATIOS: readonly ["16:9", "1:1", "4:3", "3:4", "9:16", "3:2", "2:3", "21:9"];
export declare const FULL_MATRIX_VIDEO_MODES: readonly ["text_to_video", "image_to_video", "first_last_frame", "omni_reference"];
type MatrixEndpointType = "text" | "image_generation" | "video_generation";
type MatrixImageReferenceMode = "none" | "single" | "multi";
type MatrixVideoMode = (typeof FULL_MATRIX_VIDEO_MODES)[number];
export type MatrixTextPlanItem = {
    kind: "text";
    key: string;
    ordinal: number;
    endpointType: "text";
    model: string;
    estimatedCostMicros: number;
};
export type MatrixImagePlanItem = {
    kind: "image";
    key: string;
    ordinal: number;
    endpointType: "image_generation";
    model: string;
    ratio: string;
    quality: string;
    count: 1;
    referenceMode: MatrixImageReferenceMode;
    estimatedCostMicros: number;
};
export type MatrixVideoPlanItem = {
    kind: "video";
    key: string;
    ordinal: number;
    endpointType: "video_generation";
    model: string;
    mode: MatrixVideoMode;
    resolution: "720p" | "1080p";
    ratio: "16:9" | "9:16";
    duration: 4 | 5 | 15;
    generateAudio: boolean;
    estimatedCostMicros: number;
};
export type MatrixPlanItem = MatrixTextPlanItem | MatrixImagePlanItem | MatrixVideoPlanItem;
/**
 * One monotonic end-to-end budget covers submission and polling. Even the
 * shortest/model-fastest row is above the observed 193.613s completion, while
 * 15s rows receive a substantially larger window.
 */
export declare function fullMatrixVideoDeadlineMs(item: Pick<MatrixVideoPlanItem, "model" | "duration">): number;
/**
 * The execution order intentionally creates six no-reference images before
 * any referenced item. That gives every later "multi" row at least two
 * distinct, project-owned AssetVersion references without adding setup calls.
 */
export declare function buildFullMatrixPlan(): MatrixPlanItem[];
export declare const FULL_MATRIX_PLAN: readonly MatrixPlanItem[];
export declare function fullMatrixPlanDigest(plan?: readonly MatrixPlanItem[]): string;
export declare function validateFullMatrixPlan(plan?: readonly MatrixPlanItem[]): {
    total: 41;
    text: 5;
    image: 24;
    video: 12;
    estimatedCostMicros: number;
};
type FullMatrixAuthorizationRefreshBoundary = Readonly<{
    nextOperationKey: string;
    nextOperationOrdinal: number;
    paidCallsStarted: number;
    paidCallsStartedThisSegment: number;
}>;
export declare class FullMatrixCandidateError extends Error {
    readonly code: string;
    readonly exitCode: number;
    paidCallsStarted: number;
    candidateEArmingCleanup: Readonly<{
        armingFile: string;
        operationKey: string;
        packageDigest: string;
    }> | null;
    authorizationRefreshBoundary: FullMatrixAuthorizationRefreshBoundary | null;
    authorizationRefreshReceiptWritten: boolean;
    constructor(code: string, exitCode?: number);
}
export type FullMatrixCommand = {
    kind: "help";
} | {
    kind: "self-check";
} | {
    kind: "preflight";
    sessionFile: string;
    evidenceFile: string;
} | {
    kind: "reconcile";
    sessionFile: string;
    evidenceFile: string;
} | {
    kind: "negative-gates";
    sessionFile: string;
    evidenceFile: string;
} | {
    kind: "run";
    sessionFile: string;
    evidenceFile: string;
    paidFullMatrix: true;
    resume: boolean;
    absorbedNoDeliveryContinuation: boolean;
    authorizationSegmentIndex: number;
    authorizationSegmentLimit: number;
    authorizationPackageFile: string;
    authorizationPackageFileDigest: string;
    authorizationPackageFileIdentityBinding: string | null;
};
export declare function parseFullMatrixCommand(args: readonly string[], environment?: NodeJS.ProcessEnv): FullMatrixCommand;
type UsageItem = {
    id: string;
    workspaceId: string;
    endpointType: string;
    model: string;
    status: string;
    taskId: string | null;
    requestId: string | null;
    units: number;
    unit: string;
    currency: string;
    costMicros: number;
};
type LibraryItem = {
    id: string;
    taskId: string;
    projectId: number;
    projectAssetId?: string | null;
    assetVersionId?: string | null;
    assetType: string;
    model: string;
    status: string;
    url: string;
    width: number | null;
    height: number | null;
    durationMs: number | null;
};
type BillingLedgerItem = {
    id: string;
    workspaceId: string;
    type: string;
    status: string;
    amountMicros: number;
    remainingMicros: number;
    relatedLedgerId: string | null;
    usageRecordId: string | null;
    taskId: string | null;
    requestId: string | null;
    idempotencyKey: string | null;
    metadata: Record<string, unknown>;
};
export type MatrixMediaProof = {
    file: string;
    sha256: string;
    bytes: number;
    mimeType: string;
    width: number;
    height: number;
    durationMs?: number;
};
export type MatrixRecoveryHandles = {
    usageIds: string[];
    taskIds: string[];
    assetIds: string[];
    assetVersionIds: string[];
};
export type MatrixPlatformAbsorptionV2 = {
    contractVersion: "billing-platform-absorption.v2";
    incidentContract: "video-submit-http-400-no-provider-task-no-delivery.v1";
    reason: "submit_http_400";
    customerDeliveryStatus: "none";
    customerChargeMicros: 0;
    providerBillingStatus: "possible_not_confirmed";
    requestedUnits: number;
    observedReturnedUnits: null;
    observedValidUnits: null;
    reservedUnitPriceMicros: number;
    estimatedPlatformLossMicros: number;
    maximumProviderExposureMicros: typeof FULL_MATRIX_PLATFORM_ABSORBED_STOP_MICROS;
    customerReleaseMicros: typeof FULL_MATRIX_PLATFORM_ABSORBED_STOP_MICROS;
    estimateBasis: "maximum_reserved_exposure_due_to_unconfirmed_http_400";
    providerRequestProof: {
        contractVersion: "video-provider-request-proof.v1";
        stableJsonSha256: "c993633322a5d3d01e1c31aa766c17faf89f6bfa4e78bbefa5e324413775a026";
        utf8Bytes: 15_194_809;
        contentItems: 10;
        textItems: 1;
        imageDataUrlItems: 7;
        httpsVideoUrlItems: 2;
        textUtf8Bytes: number;
        imageDataUrlUtf8Bytes: number;
        httpsVideoUrlUtf8Bytes: number;
        referenceRoleCounts: {
            subject: 4;
            style: 3;
            storyboard: 2;
        };
    };
};
export type MatrixPriorNoChargeAttempt = {
    status: "closed_no_charge";
    attemptOrdinal: 1;
    coverageKey: string;
    planDigest: string;
    idempotencyHash: string;
    projectHash: string;
    usage: {
        ids: string[];
        endpointType: "video_generation";
        model: string;
        settlement: "released_no_charge";
        chargedCount: 0;
        units: number;
        unit: "token";
        costMicros: 0;
    };
    reservation: {
        freezeLedgers: string[];
        releaseLedgers: string[];
        releasedMicros: typeof FULL_MATRIX_PLATFORM_ABSORBED_STOP_MICROS;
        reservedMicrosAfter: 0;
        reconciliationDecision: "platform_absorb_release";
    };
    tasks: string[];
    assets: [];
    assetVersions: [];
    media: [];
    responseDigest: string;
    sealedRecovery: string;
    reason: "submit_http_400";
    platformAbsorption: MatrixPlatformAbsorptionV2;
    closedAt: string;
};
export type MatrixCompleteEvidence = {
    status: "complete";
    attemptOrdinal?: number;
    priorNoChargeAttempts?: MatrixPriorNoChargeAttempt[];
    coverageKey: string;
    planDigest: string;
    idempotencyHash: string;
    projectHash: string;
    usage: {
        ids: string[];
        endpointType: MatrixEndpointType;
        model: string;
        chargedCount: 1;
        units: number;
        unit: string;
        costMicros: number;
    };
    tasks: string[];
    assets: string[];
    assetVersions: string[];
    media: MatrixMediaProof[];
    responseDigest: string;
    sealedRecovery: string;
    completedAt: string;
};
export type MatrixIncompleteEvidence = {
    status: "pending" | "uncertain" | "failed";
    attemptOrdinal?: number;
    priorNoChargeAttempts?: MatrixPriorNoChargeAttempt[];
    coverageKey: string;
    planDigest: string;
    idempotencyHash: string;
    startedAt: string;
    sealedRecovery: string;
    reason?: string;
};
/**
 * A terminal billing failure is deliberately not successful matrix coverage.
 * It only proves that one already-started call reached a durable zero-charge
 * end state and therefore must never be submitted again in this candidate.
 */
export type MatrixClosedNoChargeEvidence = {
    status: "closed_no_charge";
    attemptOrdinal?: 1;
    coverageKey: string;
    planDigest: string;
    idempotencyHash: string;
    projectHash: string;
    usage: {
        ids: string[];
        endpointType: MatrixEndpointType;
        model: string;
        settlement: "released_no_charge";
        chargedCount: 0;
        units: number;
        unit: string;
        costMicros: 0;
    };
    reservation: {
        freezeLedgers: string[];
        releaseLedgers: string[];
        releasedMicros: number;
        reservedMicrosAfter: 0;
        reconciliationDecision: "reservation_released" | "platform_absorb_release";
    };
    tasks: string[];
    assets: [];
    assetVersions: [];
    media: [];
    responseDigest: string;
    sealedRecovery: string;
    reason: string;
    platformAbsorption?: MatrixPlatformAbsorptionV2;
    closedAt: string;
};
export type MatrixEvidenceEntry = MatrixCompleteEvidence | MatrixClosedNoChargeEvidence | MatrixIncompleteEvidence;
export type MatrixEvidenceManifest = {
    version: typeof FULL_MATRIX_MANIFEST_VERSION;
    planVersion: typeof FULL_MATRIX_PLAN_VERSION;
    planDigest: string;
    sessionBinding: string;
    createdAt: string;
    updatedAt: string;
    entries: Record<string, MatrixEvidenceEntry>;
    manifestSeal: string;
};
export declare function fullMatrixManifestBinding(evidenceFile: string, manifest: MatrixEvidenceManifest): string;
export declare function fullMatrixPaidGuardDriver(input: {
    evidenceFile: string;
    session: CandidateAcceptanceSession;
    manifest: MatrixEvidenceManifest;
}): Record<string, unknown>;
/**
 * Permanently seals one candidate session before the first matrix HTTP call.
 * The guard contains hashes only and is deliberately never removed.
 */
export declare function acquireFullMatrixPaidExecutionGuard(input: {
    sessionFile: string;
    evidenceFile: string;
    session: CandidateAcceptanceSession;
    manifest: MatrixEvidenceManifest;
    acknowledgement: string;
    now?: () => number;
    authorization?: CandidateExactAuthorizationConsumption;
    liveReadback?: CandidateExactAuthorizationLiveReadbackProof;
    guardFile?: string;
}): string;
export declare function assertFullMatrixPaidExecutionGuard(input: {
    sessionFile: string;
    evidenceFile: string;
    session: CandidateAcceptanceSession;
    manifest: MatrixEvidenceManifest;
    authorization?: CandidateExactAuthorizationConsumption;
    guardFile?: string;
    now?: number;
}): string;
declare const FULL_MATRIX_AUTHORIZATION_LINEAGE_VERSION: "fanjin-workbench-full-matrix-authorization-lineage/v1";
type FullMatrixAuthorizationLineage = Readonly<{
    version: typeof FULL_MATRIX_AUTHORIZATION_LINEAGE_VERSION;
    sessionBinding: string;
    manifestBinding: string;
    planVersion: typeof FULL_MATRIX_PLAN_VERSION;
    planDigest: string;
    operationSetDigest: string;
    batchDAbsorbedOperationKey: string | null;
    formalCandidateIdentityDigest: string;
    authorizationSessionBinding: string;
    workspaceBinding: string;
    walletBinding: string;
    rootPackageDigest: string;
    rootGuardPathBinding: string;
    rootGuardFileDigest: string;
    rootGuardInodeBinding: string;
    createdAt: string;
    lineageSeal: string;
}>;
export declare function fullMatrixAuthorizationOperationSetDigest(authorization: CandidateExactAuthorizationConsumption): string;
export declare function fullMatrixAuthorizationSegmentGuardFile(sessionFile: string, authorization: CandidateExactAuthorizationConsumption): string;
export declare function createFullMatrixAuthorizationLineage(input: {
    sessionFile: string;
    evidenceFile: string;
    session: CandidateAcceptanceSession;
    manifest: MatrixEvidenceManifest;
    authorization: CandidateExactAuthorizationConsumption;
    now?: () => number;
}): string;
export declare function assertFullMatrixAuthorizationLineage(input: {
    sessionFile: string;
    evidenceFile: string;
    session: CandidateAcceptanceSession;
    manifest: MatrixEvidenceManifest;
    authorization: CandidateExactAuthorizationConsumption;
}): FullMatrixAuthorizationLineage;
export declare function assertFullMatrixAuthorizationRenewalWindow(input: {
    authorization: CandidateExactAuthorizationConsumption;
    now: number;
    minimumRemainingMs?: number;
}): void;
export declare function acquireFullMatrixAbsorbedContinuationGuard(input: {
    sessionFile: string;
    evidenceFile: string;
    session: CandidateAcceptanceSession;
    manifest: MatrixEvidenceManifest;
    priorAttempt: MatrixPriorNoChargeAttempt;
    acknowledgement: string;
    now?: () => number;
    authorization?: CandidateExactAuthorizationConsumption;
}): string;
export declare function assertFullMatrixAbsorbedContinuationGuard(input: {
    sessionFile: string;
    evidenceFile: string;
    session: CandidateAcceptanceSession;
    manifest: MatrixEvidenceManifest;
    priorAttempt: MatrixPriorNoChargeAttempt;
    acknowledgement: string;
    authorization?: CandidateExactAuthorizationConsumption;
}): string;
export declare function sealMatrixRecoveryHandles(session: CandidateAcceptanceSession, handles: MatrixRecoveryHandles, randomBytes?: (size: number) => Buffer): string;
export declare function openMatrixRecoveryHandles(session: CandidateAcceptanceSession, sealed: string): MatrixRecoveryHandles;
export declare function isMatrixVideoAbsorbedNoDeliveryClosure(item: MatrixPlanItem, value: unknown): value is MatrixPriorNoChargeAttempt;
export declare function readOrCreateMatrixManifest(evidenceFile: string, session: CandidateAcceptanceSession, now?: () => number): MatrixEvidenceManifest;
export declare function writeMatrixManifest(evidenceFile: string, manifest: MatrixEvidenceManifest, session: CandidateAcceptanceSession): void;
type MatrixCatalog = {
    text: Map<string, Record<string, any>>;
    image: Map<string, Record<string, any>>;
    video: Map<string, Record<string, any>>;
    pricing: Map<string, Record<string, any>>;
};
export declare function validateFullMatrixCatalog(input: {
    modelOptions: CandidateHttpResponse;
    pricing: CandidateHttpResponse;
}): MatrixCatalog;
type CandidateReconciliationTerminal = {
    status: string;
    decision: string | null;
    reason: string;
    imageNoDeliveryProof?: true;
    videoNoDeliveryProof?: true;
    videoTaskId?: string;
    platformAbsorption?: Record<string, unknown>;
    /**
     * A charged image command can finish the provider call and billing
     * settlement, then lose only the HTTP response/materialization boundary.
     * These handles are recovered from the exact durable command row so the
     * candidate can bind the already-created library assets without submitting
     * the paid request again. They are kept in memory only and are never
     * written to the manifest or stdout.
     */
    recoveredImageModel?: string;
    recoveredImageCount?: number;
    recoveredImageAssets?: Array<{
        mediaAssetId: string;
        taskId: string;
        assetVersionId: string;
    }>;
};
/**
 * Reads only the isolated candidate database located beside its 0600 session
 * file. This avoids granting the browser user an admin reconciliation API
 * while still proving the exact watchdog row is terminal. No identifier or
 * database value is printed or persisted by this reader.
 */
export declare function readCandidateReconciliationTerminal(input: {
    sessionFile: string;
    workspaceId: string;
    reconciliationJobId: string;
    reservationId: string;
    usageRecordId: string;
    actorUserId?: number;
    idempotencyKey?: string;
}): Promise<CandidateReconciliationTerminal | null>;
export declare function idempotencyKey(session: CandidateAcceptanceSession, item: MatrixPlanItem, attemptOrdinal?: number): string;
export declare function assertFullMatrixNegativePayload(payload: unknown): void;
export declare function resolveFullMatrixMediaUrl(baseUrl: string, value: string): string;
declare function defaultProbeImage(input: {
    url: string;
    destination: string;
    ratio: string;
    quality: string;
}): Promise<MatrixMediaProof>;
declare function defaultProbeVideo(input: {
    url: string;
    destination: string;
    ratio: string;
    resolution: "720p" | "1080p";
    duration: number;
}): Promise<MatrixMediaProof>;
declare function hashAndProbeExistingImage(input: {
    file: string;
    ratio: string;
    quality: string;
}): Promise<MatrixMediaProof>;
declare function hashAndProbeExistingVideo(input: {
    file: string;
    ratio: string;
    resolution: "720p" | "1080p";
    duration: number;
}): Promise<MatrixMediaProof>;
export declare function emptyMatrixRecoveryHandles(): MatrixRecoveryHandles;
export declare function appendUniqueFullMatrixVersionIds(target: string[], values: readonly string[]): void;
type MatrixPaidDispatchAuthorization = Readonly<{
    headers: Readonly<Record<string, string>>;
    absorbedOperationProof: CandidateExactAuthorizationAbsorbedOperationProof | null;
    candidateEArmingFile: string | null;
}>;
type MatrixDependencies = {
    request: CandidateHttpRequest;
    sleep: (milliseconds: number) => Promise<void>;
    now: () => number;
    monotonicNow: () => number;
    probeImage: typeof defaultProbeImage;
    probeVideo: typeof defaultProbeVideo;
    probeExistingImage: typeof hashAndProbeExistingImage;
    probeExistingVideo: typeof hashAndProbeExistingVideo;
    readReconciliationTerminal: typeof readCandidateReconciliationTerminal;
    onPaidCallStarted: (count: number, key: string) => void;
    authorizationFetch: typeof fetch;
    beforePaidDispatch: (input: {
        item: MatrixPlanItem;
        idempotency: string;
        requestBody: Record<string, unknown>;
    }) => Promise<MatrixPaidDispatchAuthorization>;
};
export type FullMatrixReport = {
    ok: true;
    mode: "paid-full-matrix";
    resumed: boolean;
    planDigest: string;
    plannedCalls: 41;
    providerSubmissionAttempts: number;
    successfulCoverage: 41;
    platformAbsorbedAttempts: number;
    paidCallsStarted: number;
    paidCallsStartedThisRun: number;
    completed: number;
    skippedAfterLiveRevalidation: number;
    expectedCostLimitMicros: number;
    spendStopMicros: typeof FULL_MATRIX_SPEND_STOP_MICROS;
    customerSpendStopMicros: typeof FULL_MATRIX_SPEND_STOP_MICROS;
    platformAbsorbedStopMicros: typeof FULL_MATRIX_PLATFORM_ABSORBED_STOP_MICROS;
    grossExposureStopMicros: typeof FULL_MATRIX_GROSS_EXPOSURE_STOP_MICROS;
    actualCostMicros: number;
    platformAbsorbedMicros: number;
    grossExposureMicros: number;
    reservedMicrosAfter: 0;
    coverage: {
        text: 5;
        image: 24;
        video: 12;
    };
    outputGuards: {
        rawIdsPrinted: false;
        rawUrlsPrinted: false;
        tokenPrinted: false;
        automaticPaidRetry: false;
        absorbedNoDeliveryContinuation: boolean;
    };
};
export declare function fullMatrixCandidateEArmingFile(input: {
    sessionFile: string;
    operationKey: string;
    packageDigest: string;
}): string;
/**
 * Removes only the current package-scoped Candidate E arming file after a
 * final authorization-window zero-call exit.  This is intentionally narrower
 * than general temporary-file cleanup: any irreversible Candidate E sidecar,
 * paid counter change, or matrix evidence row makes deletion forbidden.
 */
export declare function removeUnstartedCandidateEArmingFile(input: {
    sessionFile: string;
    evidenceFile: string;
    session: CandidateAcceptanceSession;
    manifest: MatrixEvidenceManifest;
    authorization: CandidateExactAuthorizationConsumption;
    operationKey: string;
    armingFile: string;
    paidCallsBeforeItem: number;
    paidCallsStarted: number;
}): boolean;
export declare function fullMatrixVideoReferences(input: {
    item: MatrixVideoPlanItem;
    imageVersions: readonly string[];
    videoVersions: readonly string[];
    attemptOrdinal?: number;
}): Array<{
    assetVersionId: string;
    role: "first_frame" | "last_frame" | "subject" | "style" | "storyboard";
}>;
export declare function runNegativeZeroUpstreamGates(input: {
    session: CandidateAcceptanceSession;
    request: CandidateHttpRequest;
}): Promise<void>;
type NegativeGateCollectionSnapshot = {
    count: number;
    digest: string;
};
export type NegativeGateStateSnapshot = {
    tasks: NegativeGateCollectionSnapshot;
    assets: {
        library: NegativeGateCollectionSnapshot;
        projectImages: NegativeGateCollectionSnapshot;
    };
    usage: NegativeGateCollectionSnapshot;
    ledgers: NegativeGateCollectionSnapshot;
    billing: {
        reservedMicros: number;
        availableMicrosDigest: string;
    };
};
type NegativeGateCaseEvidence = {
    key: "image-count-2" | "image-quality-8k";
    status: 400 | 422;
    responseDigest: string;
};
export type NegativeGatesOnlyReport = {
    ok: true;
    mode: "negative-gates-only";
    evidenceVersion: typeof FULL_MATRIX_NEGATIVE_GATES_EVIDENCE_VERSION;
    evidenceCreated: true;
    evidenceDigest: string;
    rejectedPreDispatchRequests: typeof FULL_MATRIX_NEGATIVE_GATES_REQUEST_COUNT;
    cases: NegativeGateCaseEvidence[];
    snapshots: {
        before: NegativeGateStateSnapshot;
        after: NegativeGateStateSnapshot;
        exactMatch: true;
    };
    deltas: {
        tasks: 0;
        libraryAssets: 0;
        projectImageAssets: 0;
        usage: 0;
        ledgers: 0;
        reservedMicros: 0;
    };
    paidCallsStarted: 0;
    generationSubmissions: 0;
    upstreamGenerationSubmissions: 0;
    automaticPaidRetry: false;
    outputGuards: {
        rawIdsPrinted: false;
        rawUrlsPrinted: false;
        tokenPrinted: false;
    };
};
export declare function runNegativeGatesOnlyCandidate(input: {
    session: CandidateAcceptanceSession;
    sessionFile: string;
    evidenceFile: string;
    acknowledgement: string;
    dependencies?: {
        request?: CandidateHttpRequest;
        now?: () => number;
    };
}): Promise<NegativeGatesOnlyReport>;
/**
 * HTTP 500 response redaction intentionally treats `code` as sensitive.  The
 * non-sensitive `failureKind` is therefore the only wire-stable discriminator
 * for the controlled Candidate E post-settlement failpoint.
 */
export declare function assertCandidateESettledFailureResponse(input: {
    response: CandidateHttpResponse;
    candidateEArmingFile: string | null;
}): void;
export declare function pollFullMatrixVideoTask(input: {
    session: CandidateAcceptanceSession;
    taskId: string;
    item: Pick<MatrixVideoPlanItem, "model" | "duration">;
    request: CandidateHttpRequest;
    sleep: (milliseconds: number) => Promise<void>;
    monotonicNow: () => number;
    deadlineMonotonicMs?: number;
}): Promise<Record<string, any>>;
export declare function fullMatrixUsageRequestId(session: CandidateAcceptanceSession, item: MatrixPlanItem, attemptOrdinal?: number): string;
export declare function usageForIncompleteEntry(input: {
    session: CandidateAcceptanceSession;
    item: MatrixPlanItem;
    handles: MatrixRecoveryHandles;
    usage: readonly UsageItem[];
    ledgers: readonly BillingLedgerItem[];
    requireLedgerBinding?: boolean;
    attemptOrdinal?: number;
}): UsageItem | null;
export declare function libraryRowMatchesIncompleteEntry(input: {
    session: CandidateAcceptanceSession;
    item: MatrixPlanItem;
    handles: MatrixRecoveryHandles;
    knownTaskIds: ReadonlySet<string>;
    row: LibraryItem;
}): boolean;
export type FullMatrixReconcileReport = {
    ok: true;
    mode: "reconcile-only";
    closureComplete: boolean;
    startedEntriesSettled: boolean;
    completedRevalidated: number;
    reconciled: number;
    terminalNoCharge: number;
    unresolved: number;
    notStarted: number;
    reservedMicrosAfter: number;
    paidCallsStarted: 0;
    generationSubmissions: 0;
};
export type FullMatrixResumeState = {
    previousPaidCallsStarted: number;
    completed: number;
    notStarted: number;
    historicalCostMicros: number;
    remainingExpectedCostMicros: number;
    notStartedKeys: string[];
    platformAbsorbedMicros: number;
    grossExposureMicros: number;
    continuationPriorAttempt?: MatrixPriorNoChargeAttempt;
};
/**
 * A paid resume can only advance rows that have never been started. Any
 * pending/uncertain/failed row must first be closed by --reconcile-only;
 * replaying its paid submission is deliberately unsupported.
 */
export declare function inspectFullMatrixResumeState(manifest: MatrixEvidenceManifest, options?: {
    absorbedNoDeliveryContinuation?: boolean;
}): FullMatrixResumeState;
export declare function reconcileFullMatrixCandidate(input: {
    session: CandidateAcceptanceSession;
    sessionFile: string;
    evidenceFile: string;
    authorization?: CandidateExactAuthorizationConsumption;
    dependencies?: Partial<MatrixDependencies>;
}): Promise<FullMatrixReconcileReport>;
export declare function runFullMatrixCandidate(input: {
    session: CandidateAcceptanceSession;
    sessionFile: string;
    evidenceFile: string;
    acknowledgement: string;
    absorbedContinuationAcknowledgement?: string;
    resume?: boolean;
    absorbedNoDeliveryContinuation?: boolean;
    authorization?: CandidateExactAuthorizationConsumption;
    dependencies?: Partial<MatrixDependencies>;
}): Promise<FullMatrixReport>;
export declare function preflightFullMatrixCandidate(input: {
    session: CandidateAcceptanceSession;
    sessionFile: string;
    evidenceFile: string;
    dependencies?: Pick<MatrixDependencies, "request">;
}): Promise<Record<string, unknown>>;
export declare function fullMatrixSelfCheck(): Record<string, unknown>;
export declare function main(): Promise<void>;
