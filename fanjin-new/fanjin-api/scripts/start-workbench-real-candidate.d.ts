import { type RealCandidateCheckpointDependencies } from "./lib/real-candidate-durable-checkpoint";
export declare const REAL_CANDIDATE_ACK_ENV = "FANJIN_REAL_CANDIDATE_ACK";
export declare const REAL_CANDIDATE_ACK_VALUE = "LOCAL_BROWSER_MAY_SPEND_REAL_UPSTREAM_CREDIT";
export declare const REAL_CANDIDATE_ARM_FLAG = "--armed";
export declare const REAL_CANDIDATE_CHECKPOINT_DIR_FLAG = "--checkpoint-dir";
export declare const REAL_CANDIDATE_FREEZE_RECEIPT_FLAG = "--freeze-receipt";
export declare const REAL_CANDIDATE_LOCAL_ONLY_FREEZE_FLAG = "--candidate-only-freeze";
export declare const REAL_CANDIDATE_LOCAL_ONLY_FREEZE_ACK_ENV = "FANJIN_REAL_CANDIDATE_LOCAL_ONLY_FREEZE_ACK";
export declare const REAL_CANDIDATE_LOCAL_ONLY_FREEZE_ACK_VALUE = "I_ACCEPT_DEV_LOCAL_ONLY_FREEZE_IS_NOT_FORMAL_B0";
export declare const REAL_CANDIDATE_CLEANUP_FLAG = "--cleanup-checkpoint";
export declare const REAL_CANDIDATE_CLEANUP_ACK_ENV = "FANJIN_REAL_CANDIDATE_CLEANUP_ACK";
export declare const REAL_CANDIDATE_CLEANUP_ACK_VALUE = "I_ACCEPT_DELETE_EXACT_STOPPED_CANDIDATE_CHECKPOINT";
export declare const REAL_CANDIDATE_FUNDING_MICROS = 800000000000;
export declare const REAL_CANDIDATE_PAID_GENERATION_REQUESTS = 0;
export declare const REAL_CANDIDATE_AGENT_TOOL_LOOP_LIMITS: Readonly<{
    maxTurns: 3;
    maxToolCalls: 1;
}>;
declare const PROVIDER_ENV_NAMES: readonly ["FANJIN_PROVIDER_NEWAPI_SINE_API_KEY", "VOLCANO_ARK_API_KEY"];
export declare const REAL_CANDIDATE_KEYCHAIN_ENTRIES: readonly [{
    readonly service: "fanjin.local.dev.secrets";
    readonly envName: "FANJIN_PROVIDER_NEWAPI_SINE_API_KEY";
    readonly account: "newapi-sine-fmusic";
}, {
    readonly service: "fanjin.local.dev.secrets";
    readonly envName: "VOLCANO_ARK_API_KEY";
    readonly account: "volcano-ark";
}];
export declare const REAL_CANDIDATE_VOLCENGINE_ROOT_KEYCHAIN_ENTRIES: readonly [{
    readonly service: "fanjin.prod.volcengine.root";
    readonly account: "access-key-id";
}, {
    readonly service: "fanjin.prod.volcengine.root";
    readonly account: "secret-access-key";
}];
export declare const REAL_CANDIDATE_PREFLIGHT_ENDPOINTS: readonly ["GET https://sine.fmusic.cc/v1/models", "GET https://ark.cn-beijing.volces.com/api/v3/models", "POST https://open.volcengineapi.com/?Action=GetApiKey&Version=2024-01-01 (only after Ark HTTP 401)", "POST /api/project/addProject", "GET /api/projects/:projectId/canvases", "POST /api/projects/:projectId/canvases (database-only canvas preparation)", "GET /api/canvas/load?canvasId=:canvasId (database-only seed verification)", "POST /api/canvas/save (one-shot database-only text seed; never retried)", "GET /api/projects/:projectId/creationSessions/current", "POST /api/projects/:projectId/creationSessions/current (database-only session preparation)", "PUT /api/projects/:projectId/creationSessions/:sessionId (database-only session binding)", "GET /api/agent/skills", "GET /api/agent/chat-models", "POST /api/workbench/create/modelOptions"];
export declare const REAL_CANDIDATE_VISUAL_CANVAS_NAME = "0.0.8 \u89C6\u89C9\u9A8C\u6536\u753B\u5E03";
export declare const REAL_CANDIDATE_VISUAL_SESSION_GOAL = "0.0.8 \u53CC\u89C6\u53E3\u89C6\u89C9\u9A8C\u6536";
export declare const REAL_CANDIDATE_VISUAL_CANVAS_VIEWPORT: Readonly<{
    readonly x: 0;
    readonly y: 0;
    readonly zoom: 1;
}>;
export declare const REAL_CANDIDATE_VISUAL_TEXT_NODE: Readonly<{
    readonly id: "candidate-visual-text-v1";
    readonly type: "text";
    readonly title: "0.0.8 视觉验收文本";
    readonly titleCustomized: true;
    readonly x: 480;
    readonly y: 100;
    readonly width: 440;
    readonly height: 440;
    readonly ratio: "1:1";
    readonly prompt: "0.0.8 双视口视觉验收";
    readonly outputText: "0.0.8 双视口视觉验收";
    readonly textVisited: true;
    readonly isGenerating: false;
    readonly generationState: "idle";
    readonly taskStatus: "idle";
}>;
type CandidateEndpointType = "text" | "image_generation" | "video_generation" | "multimodal_embedding";
type CandidateModel = {
    endpointType: CandidateEndpointType;
    model: string;
    priority: number;
    unit: "token" | "image";
    unitPriceMicros: number;
    ruleConfig: Record<string, unknown>;
};
export declare const REAL_CANDIDATE_MODELS: readonly CandidateModel[];
export declare const REAL_CANDIDATE_SINE_UPSTREAM_MODEL_IDS: readonly ["claude-opus-4-8", "gpt-5.6-luna"];
export declare const REAL_CANDIDATE_VOLCANO_MODEL_IDS: readonly string[];
export declare const REAL_CANDIDATE_REQUIRED_CATALOG_MODEL_IDS: Readonly<{
    text: readonly ["agent-main"];
    image: readonly ["doubao-seedream-5-0-260128"];
    video: readonly ["doubao-seedance-2-0-fast-260128"];
}>;
type HarnessCommand = "help" | "self-check" | "start" | "cleanup";
export declare class CandidateHarnessError extends Error {
    readonly code: string;
    readonly exitCode: number;
    constructor(code: string, exitCode?: number);
}
export declare function parseCandidateHarnessCommand(args: readonly string[], environment?: NodeJS.ProcessEnv): HarnessCommand;
export declare function candidateCheckpointDirectoryFromArgs(args: readonly string[]): string | undefined;
export declare function candidateFreezeReceiptFromArgs(args: readonly string[]): string | undefined;
export declare function candidateOnlyFreezeFromArgs(args: readonly string[]): boolean;
export declare function candidateReleaseIdentityFromArgs(args: readonly string[]): import("./lib/release-candidate-session-identity").ReleaseCandidateSessionIdentity;
export declare function candidateTerminalLifecycle(exitCode: number, securityIntegrityFailure?: boolean): "stopped" | "interrupted" | "failed";
export declare function candidateFailureLifecycle(error: unknown): "interrupted" | "failed";
export declare function keychainReadArgs(account: string): string[];
export declare function keychainReadArgsForService(service: string, account: string): string[];
export declare function configureIsolatedEnvironment(target: NodeJS.ProcessEnv, dataDir: string, credentials: Readonly<Record<(typeof PROVIDER_ENV_NAMES)[number], string>>): void;
export declare function clearCandidateProviderCredentials(target: NodeJS.ProcessEnv): void;
export declare function candidateRouteConfig(entry: CandidateModel, baseConfig: Record<string, unknown>, verifiedModelIds: ReadonlySet<string>): Record<string, unknown>;
export declare function candidateAgentRouteConfig(baseConfig: Record<string, unknown>, upstreamModel: string, verifiedModelIds: ReadonlySet<string>): Record<string, unknown>;
export type CandidateVisualPreparationHttpResponse = {
    status: number;
    body: Record<string, any>;
};
export type CandidateVisualPreparationRequest = (pathname: string, payload: Record<string, unknown> | undefined, method: "GET" | "POST" | "PUT") => Promise<CandidateVisualPreparationHttpResponse>;
/**
 * Prepare the Canvas and current CreationSession required by the visual
 * verifier. These endpoints only mutate the isolated candidate database.
 *
 * A write is never retried. If the response is lost, the function performs a
 * GET and accepts the state only when the complete expected result is durable.
 */
export declare function prepareCandidateVisualProjectState(input: {
    projectId: number;
    request: CandidateVisualPreparationRequest;
    assertNoPaidSideEffects: () => Promise<void>;
}): Promise<{
    canvasPrepared: true;
    creationSessionPrepared: true;
    paidGenerationRequests: 0;
}>;
type CandidateCatalogEntry = Record<string, unknown> & {
    id: string;
};
export type CandidateCreationCatalogSummary = {
    llmModels: CandidateCatalogEntry[];
    submittableImages: CandidateCatalogEntry[];
    submittableVideos: CandidateCatalogEntry[];
};
export declare function assertCandidateCreationCatalog(value: unknown): CandidateCreationCatalogSummary;
export type CandidateReadOnlyCredentialProbe = {
    ok: boolean;
    status: number;
    modelIds: readonly string[];
};
export declare function parseCandidateModelListIds(payload: unknown): readonly string[] | null;
export declare function probeReadOnlyCredential(provider: "sine" | "volcano", url: string, secret: string, fetchFn?: typeof fetch): Promise<CandidateReadOnlyCredentialProbe>;
type CandidateProviderCredentials = Record<(typeof PROVIDER_ENV_NAMES)[number], string>;
export type CandidateVolcanoCredentialSource = "local-keychain" | "temporary-preset-endpoint" | "production-sealed-transfer";
export type CandidateCredentialBootstrapDependencies = {
    readSecret: (service: string, account: string) => string;
    probe: (provider: "sine" | "volcano", url: string, secret: string) => Promise<CandidateReadOnlyCredentialProbe>;
    mintTemporaryVolcanoApiKey: (input: {
        accessKeyId: string;
        secretAccessKey: string;
        resourceIds: readonly string[];
    }) => Promise<{
        apiKey: string;
    }>;
};
export type CandidateCredentialBootstrapOptions = {
    /**
     * Resolves a Volcano credential in memory. The resolver is intentionally
     * supplied by the caller so the candidate launcher never needs to persist
     * or pass the plaintext through argv or the launch environment.
     */
    injectedVolcanoCredential?: () => Promise<string>;
};
export type CandidateCredentialBootstrapResult = {
    credentials: CandidateProviderCredentials;
    providerSecrets: readonly string[];
    verifiedModelIds: Readonly<{
        sine: readonly string[];
        volcano: readonly string[];
    }>;
    volcanoCredentialSource: CandidateVolcanoCredentialSource;
};
export declare function bootstrapCandidateProviderCredentials(dependencies: CandidateCredentialBootstrapDependencies, options?: CandidateCredentialBootstrapOptions): Promise<CandidateCredentialBootstrapResult>;
export declare function bufferContainsSecret(buffer: Buffer, secrets: readonly string[]): boolean;
export declare function assertProviderSecretsNotPersisted(dataDir: string, secrets: readonly string[]): void;
export type CandidateHarnessStartOptions = {
    credentialBootstrap?: (dependencies: CandidateCredentialBootstrapDependencies) => Promise<CandidateCredentialBootstrapResult>;
};
export declare function defaultCandidateCredentialBootstrapDependencies(): CandidateCredentialBootstrapDependencies;
export declare function buildCandidateSafeStartupReport(input: {
    baseUrl: string;
    checkpointName: string;
    checkpointBinding: string;
    probeChannelCount: number;
    volcanoCredentialSource: CandidateVolcanoCredentialSource;
    modelCounts: {
        text: number;
        image: number;
        video: number;
    };
    agentCatalog: {
        skillCount: number;
        chatModelCount: number;
    };
    candidateIdentity?: {
        evidenceClass: string;
        formalB0Eligible: boolean;
        runtimeArtifactBindingVerified: boolean;
        freezeReceiptDigest: string;
        releaseUuid: string;
        artifactUuid: string;
        artifactSha256: string;
        sourceDigest: string;
        configExpectedSha256: string;
    };
}): {
    ok: boolean;
    mode: string;
    baseUrl: string;
    apiBaseUrl: string;
    rawBusinessIdentifiersPrinted: boolean;
    runtimeLogProjection: string;
    absoluteRuntimePathsPrinted: boolean;
    agentToolLoopLimits: Readonly<{
        maxTurns: 3;
        maxToolCalls: 1;
    }>;
    checkpoint: {
        scope: string;
        name: string;
        anonymousBinding: string;
        lifecycle: string;
        sessionFile: string;
        absolutePathPrinted: boolean;
        cleanup: string;
    };
    browserSessionFileMode: string;
    tokenPrinted: boolean;
    providerSecretsPrinted: boolean;
    providerSecretsPersisted: boolean;
    paidGenerationRequestsSentByHarness: number;
    releaseCandidate: {
        runtimeIdentityClaimed: boolean;
        formalRugPromoted: boolean;
        evidenceClass: string;
        formalB0Eligible: boolean;
        runtimeArtifactBindingVerified: boolean;
        freezeReceiptDigest: string;
        releaseUuid: string;
        artifactUuid: string;
        artifactSha256: string;
        sourceDigest: string;
        configExpectedSha256: string;
    } | {
        evidenceClass: string;
        formalB0Eligible: boolean;
        runtimeArtifactBindingVerified: boolean;
        runtimeIdentityClaimed: boolean;
        formalRugPromoted: boolean;
    };
    readOnlyProviderProbes: number;
    volcanoCredentialSource: CandidateVolcanoCredentialSource;
    temporaryVolcanoCredentialMinted: boolean;
    temporaryVolcanoCredentialDurationSeconds: number;
    fundedGu: number;
    modelCounts: {
        text: number;
        image: number;
        video: number;
    };
    agentReadOnlyPreflight: {
        skills: number;
        chatModels: number;
        capabilities: string[];
    };
    publicVideoResolutions: string[];
    frontend: {
        cwdScope: string;
        proxyEnvironment: string;
        suggestedPort: number;
    };
    cleanup: string;
};
export declare function cleanupCandidateCheckpoint(dataDirectory: string, checkpointDependencies?: RealCandidateCheckpointDependencies): Promise<{
    ok: true;
    checkpointScope: string;
    previousLifecycle: "stopped";
    dataRemoved: true;
    absolutePathPrinted: false;
}>;
export declare function startCandidateHarness(options?: CandidateHarnessStartOptions): Promise<never>;
export {};
