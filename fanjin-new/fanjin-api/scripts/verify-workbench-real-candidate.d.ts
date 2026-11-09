import { type ReleaseCandidateSessionIdentity } from "./lib/release-candidate-session-identity";
import { type CandidateExactAuthorizationConsumption, type CandidateExactAuthorizationLiveReadbackProof } from "./lib/candidate-exact-authorization-v2";
export declare const CANDIDATE_ACCEPTANCE_PAID_FLAG = "--paid-minimal";
export declare const CANDIDATE_ACCEPTANCE_PAID_ACK_ENV = "FANJIN_REAL_CANDIDATE_PAID_ACK";
export declare const CANDIDATE_ACCEPTANCE_PAID_ACK_VALUE = "I_ACCEPT_EXACTLY_3_REAL_UPSTREAM_REQUESTS_TEXT_IMAGE_720P";
export declare const CANDIDATE_ACCEPTANCE_MAX_PAID_MUTATIONS = 3;
export declare const CANDIDATE_ACCEPTANCE_SESSION_VERSION = "fanjin-real-candidate-session/v1";
export declare const CANDIDATE_ACCEPTANCE_PAID_GUARD_SUFFIX = ".paid-minimal.started";
export declare const CANDIDATE_ACCEPTANCE_PAID_1080P_FLAG = "--paid-minimal-1080p";
export declare const CANDIDATE_ACCEPTANCE_PAID_1080P_ACK_ENV = "FANJIN_REAL_CANDIDATE_1080P_PAID_ACK";
export declare const CANDIDATE_ACCEPTANCE_PAID_1080P_ACK_VALUE = "I_ACCEPT_EXACTLY_3_REAL_UPSTREAM_REQUESTS_TEXT_IMAGE_1080P";
export declare const CANDIDATE_ACCEPTANCE_PAID_1080P_GUARD_SUFFIX = ".paid-minimal-1080p.started";
export declare const CANDIDATE_ACCEPTANCE_VIDEO_RESOLUTION_FLAG = "--video-resolution";
export type CandidateAcceptanceVideoResolution = "720p" | "1080p";
export declare const CANDIDATE_ACCEPTANCE_VIEWPORTS: readonly [{
    readonly id: "R1";
    readonly width: 1440;
    readonly height: 900;
}, {
    readonly id: "R2";
    readonly width: 1920;
    readonly height: 1080;
}];
export type CandidateViewport = (typeof CANDIDATE_ACCEPTANCE_VIEWPORTS)[number];
type CreationEntry = {
    id: string;
    pathname: string;
    query?: Readonly<Record<string, string>>;
    allowedPathPrefixes: readonly string[];
};
export declare const CANDIDATE_ACCEPTANCE_OPEN_ENTRIES: readonly CreationEntry[];
type ClosedCreationEntry = CreationEntry & {
    label: string;
};
export declare const CANDIDATE_ACCEPTANCE_CLOSED_ENTRIES: readonly ClosedCreationEntry[];
export declare class CandidateAcceptanceError extends Error {
    readonly code: string;
    readonly exitCode: number;
    paidMutationRequestsSent: number;
    constructor(code: string, exitCode?: number);
}
export type CandidateAcceptanceSession = {
    version: typeof CANDIDATE_ACCEPTANCE_SESSION_VERSION;
    baseUrl: string;
    apiBaseUrl: string;
    token: string;
    tokenStorageKeys: readonly string[];
    username: string;
    userId: number;
    workspaceId: string;
    projectId: number;
    createdAt: string;
    /**
     * Runtime session files require this field. It remains optional on the
     * exported structural type so deterministic unit fixtures that never cross
     * the 0600-file trust boundary do not masquerade as release evidence.
     */
    candidateIdentity?: ReleaseCandidateSessionIdentity;
    agentToolLoopLimits?: {
        maxTurns: number;
        maxToolCalls: number;
    };
};
export type CandidateAcceptanceCommand = {
    kind: "help";
} | {
    kind: "self-check";
} | {
    kind: "run";
    sessionFile: string;
    frontendUrl?: string;
    videoResolution: CandidateAcceptanceVideoResolution;
    paidMinimal: boolean;
    paidMinimal1080p: boolean;
    authorizationPackageFile: string | null;
    authorizationPackageFileDigest: string | null;
};
export declare function parseCandidateAcceptanceCommand(args: readonly string[], environment?: NodeJS.ProcessEnv): CandidateAcceptanceCommand;
export declare function readCandidateAcceptanceSession(sessionFile: string): CandidateAcceptanceSession;
/**
 * Permanently seals a candidate session before a paid verifier process starts.
 *
 * The file is intentionally not removed on success or failure. A process
 * manager restart must fail closed instead of replaying a paid workflow. A new
 * paid attempt therefore requires a freshly-created candidate session after an
 * operator has inspected the previous run's billing evidence.
 */
export declare function acquireCandidatePaidExecutionGuardForResolution(sessionFile: string, resolution: CandidateAcceptanceVideoResolution, authorization?: CandidateExactAuthorizationConsumption, liveReadback?: CandidateExactAuthorizationLiveReadbackProof): string;
export declare function assertCandidatePaidExecutionGuardForResolution(sessionFile: string, resolution: CandidateAcceptanceVideoResolution, authorization: CandidateExactAuthorizationConsumption, liveReadback?: CandidateExactAuthorizationLiveReadbackProof): void;
export declare function acquireCandidatePaidExecutionGuard(sessionFile: string): string;
export declare function buildCandidateEntryPath(entry: CreationEntry, projectId: number): string;
export declare function buildCandidateEntryUrl(frontendUrl: string, entry: CreationEntry, projectId: number): string;
export declare function redactCandidateEvidenceId(value: unknown): string | null;
type HttpInput = {
    path: string;
    method?: "GET" | "POST";
    body?: unknown;
    headers?: Record<string, string>;
    timeoutMs?: number;
};
export type CandidateHttpResponse = {
    status: number;
    body: Record<string, any>;
    requestId: string;
};
export type CandidateHttpRequest = (session: CandidateAcceptanceSession, input: HttpInput) => Promise<CandidateHttpResponse>;
export declare const defaultCandidateHttpRequest: CandidateHttpRequest;
type CandidateModel = {
    id: string;
    canSubmit: true;
    capabilityStatus: "verified";
    resolutions?: string[];
    qualities?: string[];
    defaultQuality?: string;
    duration?: {
        min?: number;
        max?: number;
        step?: number;
        allowed?: number[];
    };
};
export type CandidateCatalogSelection = {
    textModel: {
        id: string;
    };
    imageModel: CandidateModel;
    videoModel: CandidateModel;
    selectedVideoResolution?: CandidateAcceptanceVideoResolution;
    submittableSelectedResolutionVideoCount?: number;
    submittableImageCount: number;
    submittableVideoCount: number;
    publicVideoResolutions: string[];
};
export declare function validateCandidateAgentSkills(response: CandidateHttpResponse): {
    skillCount: number;
};
export declare function validateCandidateAgentChatModels(response: CandidateHttpResponse): {
    modelCount: number;
};
export declare function validateCandidateModelCatalog(response: CandidateHttpResponse, selectedVideoResolution?: CandidateAcceptanceVideoResolution): CandidateCatalogSelection;
export type CandidateBrowserPageSnapshot = {
    finalPath: string;
    finalSearch: string;
    bodyText: string;
    rootWidth: number;
    rootHeight: number;
    visibleElementCount: number;
    enabledActionLabels: string[];
};
export declare function inspectOpenCandidatePage(snapshot: CandidateBrowserPageSnapshot, allowedPathPrefixes: readonly string[]): string[];
export declare function inspectClosedCandidatePage(snapshot: CandidateBrowserPageSnapshot, label: string): string[];
export type CandidateBrowserProbeInput = {
    kind: "open" | "closed";
    entryId: string;
    label?: string;
    url: string;
    allowedPathPrefixes: readonly string[];
    viewport: CandidateViewport;
};
export type CandidateBrowserProbe = (input: CandidateBrowserProbeInput) => Promise<{
    issues: string[];
}>;
type PlaywrightProbeHandle = {
    probe: CandidateBrowserProbe;
    close: () => Promise<void>;
};
/**
 * Playwright serializes function-form init scripts. When this file is executed
 * through tsx/esbuild, that serialization can retain an injected `__name`
 * helper which does not exist in the browser realm. Keep this as plain browser
 * JavaScript so the authentication shim behaves identically under Vitest and
 * the real CLI runner.
 */
export declare function buildCandidateBrowserAuthInitScript(input: {
    token: string;
    apiBaseUrl: string;
}): string;
export declare function createPlaywrightCandidateBrowserProbe(input: {
    session: CandidateAcceptanceSession;
    frontendUrl: string;
}): Promise<PlaywrightProbeHandle>;
type PaidMinimalEvidence = {
    idempotencyRun: string;
    requestIds: Record<string, string | null>;
    taskIds: Record<string, string | null>;
    assetIds: Record<string, string | null>;
    gu: {
        availableBefore: number;
        availableAfter: number;
        spent: number;
        reservedBefore: number;
        reservedAfter: number;
        chargedCallsBefore: number;
        chargedCallsAfter: number;
    };
    media: {
        imageReachable: boolean;
        videoReachable: boolean;
        videoResolution: CandidateAcceptanceVideoResolution;
        videoDurationSeconds: number;
        sourceExpectedWidth: number;
        sourceExpectedHeight: number;
        sourceResolutionPlanVerified: true;
        sourcePixelDimensionsVerified: false;
        sourceFfprobePerformed: false;
    };
    delivery: {
        selectionPersisted: boolean;
        draftPersisted: boolean;
        finalReachable: boolean;
        finalWidth: number;
        finalHeight: number;
        finalDurationMs: number;
    };
};
export type PaidMinimalResult = {
    paidMutationRequestsSent: number;
    evidence: PaidMinimalEvidence;
};
type PaidMinimalDependencies = {
    request: CandidateHttpRequest;
    sleep: (milliseconds: number) => Promise<void>;
    now: () => number;
    probeMedia: (session: CandidateAcceptanceSession, url: string, kind: "image" | "video") => Promise<boolean>;
    onPaidMutationCount: (count: number) => void;
    beforePaidMutation: (stage: "director" | "image" | "video", nextCount: number) => Promise<void>;
};
export declare function shortestPaidMinimalVideoDuration(model: CandidateModel): number;
export declare function assertPaidMinimalVideoPayload(payload: unknown, expectedResolution?: CandidateAcceptanceVideoResolution): void;
export declare function runPaidMinimalCandidateAcceptance(input: {
    session: CandidateAcceptanceSession;
    catalog: CandidateCatalogSelection;
    videoResolution?: CandidateAcceptanceVideoResolution;
    dependencies?: Partial<PaidMinimalDependencies>;
}): Promise<PaidMinimalResult>;
export type CandidateAcceptanceReport = {
    ok: boolean;
    mode: "zero-paid" | "paid-minimal" | "paid-minimal-1080p";
    videoResolution: CandidateAcceptanceVideoResolution;
    viewportChecks: number;
    openEntryChecks: number;
    closedEntryChecks: number;
    failures: Array<{
        viewport: string;
        entry: string;
        issues: string[];
    }>;
    catalog: {
        imageModels: number;
        videoModels: number;
        selectedVideoResolution: CandidateAcceptanceVideoResolution;
        selectedResolutionVideoModels: number;
        publicVideoResolutions: string[];
    };
    paidMutationRequestsSent: number;
    paidEvidence?: PaidMinimalEvidence;
    releaseCandidate: {
        identityBound: boolean;
        evidenceClass?: string;
        formalB0Eligible: boolean;
        runtimeArtifactBindingVerified: boolean;
        runtimeIdentityClaimed: boolean;
        formalRugPromoted: false;
        freezeReceiptDigest?: string;
        releaseUuid?: string;
        artifactUuid?: string;
        artifactSha256?: string;
        sourceDigest?: string;
        configExpectedSha256?: string;
    };
    tokenPrinted: false;
    tokenPersistedByDriver: false;
    traceEnabled: false;
    harEnabled: false;
    screenshotEnabled: false;
};
export declare function runCandidateAcceptance(input: {
    session: CandidateAcceptanceSession;
    frontendUrl: string;
    paidMinimal: boolean;
    videoResolution?: CandidateAcceptanceVideoResolution;
    probeBrowser: CandidateBrowserProbe;
    request?: CandidateHttpRequest;
    paidDependencies?: Partial<PaidMinimalDependencies>;
}): Promise<CandidateAcceptanceReport>;
export declare function candidateAcceptanceHelpReport(): Record<string, unknown>;
export declare function candidateAcceptanceSelfCheckReport(): Record<string, unknown>;
export {};
