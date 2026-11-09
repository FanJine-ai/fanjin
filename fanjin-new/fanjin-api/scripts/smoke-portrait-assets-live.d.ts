export declare const PORTRAIT_LIVE_SMOKE_RECEIPT_VERSION: "fanjin-portrait-assets-live-smoke-receipt/v1";
export declare const PORTRAIT_LIVE_SMOKE_HANDOFF_VERSION: "fanjin-portrait-liveness-handoff/v1";
export declare const PORTRAIT_LIVE_SMOKE_PRODUCTION_BASE_URL: "https://fanjin.top";
export declare const PORTRAIT_LIVE_SMOKE_PAID_ACK_ENV: "FANJIN_PORTRAIT_LIVE_PAID_ACK";
export declare const PORTRAIT_LIVE_SMOKE_PAID_ACK_VALUE: "I_ACCEPT_REAL_VOLCANO_PORTRAIT_ASSET_REQUESTS";
export declare const PORTRAIT_LIVE_SMOKE_PRODUCTION_ACK_ENV: "FANJIN_PORTRAIT_LIVE_PRODUCTION_ACK";
export declare const PORTRAIT_LIVE_SMOKE_PRODUCTION_ACK_VALUE: "I_ACCEPT_FANJIN_TOP_PRODUCTION_MUTATIONS";
type Subject = "aigc" | "real";
type Phase = "execute" | "authorize" | "verify";
export declare class PortraitLiveSmokeError extends Error {
    readonly code: string;
    readonly exitCode: number;
    constructor(code: string, exitCode?: number);
}
export type PortraitLiveSmokeCommand = Readonly<{
    kind: "help";
}> | Readonly<{
    kind: "self-check";
}> | Readonly<{
    kind: "run";
    paid: true;
    production: true;
    baseUrl: typeof PORTRAIT_LIVE_SMOKE_PRODUCTION_BASE_URL;
    expectedReleaseId: string;
    expectedSourceCommit: string;
    expectedArtifactSha256: string;
    expectedSchemaVersion: number;
    workspaceId: string;
    projectId: number;
    assetVersionId: number;
    model: string;
    subject: Subject;
    phase: Phase;
    identityLabel: string | null;
    receiptFile: string;
    h5HandoffFile: string | null;
    pollTimeoutMs: number;
    pollIntervalMs: number;
    userSessionKeychainService: string;
    userSessionKeychainAccount: string;
    adminSessionKeychainService: string;
    adminSessionKeychainAccount: string;
}>;
type HttpStage = "release_readiness" | "admission_read" | "admission_declaration" | "liveness_authorization" | "admin_portrait_binding_before" | "admin_portrait_binding_after" | "admin_provider_channel_before" | "admin_provider_channel_after";
type HttpStageReceipt = Readonly<{
    stage: HttpStage;
    attempts: number;
    statusCounts: Readonly<Record<string, number>>;
    firstObservedAt: number;
    lastObservedAt: number;
    requestIdSha256: readonly string[];
}>;
type ReleaseEvidence = Readonly<{
    status: "matched" | "unverified";
    evidenceScope: "unverified" | "begin_end_readiness_bracket_not_per_response_node_attestation";
    releaseIdSha256: string | null;
    sourceCommit: string | null;
    artifactSha256: string | null;
    schemaVersion: number | null;
    identitySha256: string | null;
}>;
type ProviderEvidence = Readonly<{
    status: "unverified" | "awaiting_manual_h5" | "active";
    channelIdSha256: string | null;
    bindingGeneration: number | null;
    bindingGenerationStatus: "unverified" | "current_channel_stable_observation_not_historical_attestation";
    bindingSnapshotSha256: string | null;
    groupType: "AIGC" | "LivenessFace" | null;
    groupState: string | null;
    assetState: string | null;
    createAssetGroup: string;
    createVisualValidateSession: string;
    createAsset: string;
    getAsset: string;
    providerBinding: string;
}>;
export type PortraitLiveSmokeReceipt = Readonly<{
    version: typeof PORTRAIT_LIVE_SMOKE_RECEIPT_VERSION;
    status: "passed" | "failed";
    failureCode: string | null;
    workflow: "AIGC" | "LivenessFace";
    phase: Phase;
    startedAt: number;
    finishedAt: number;
    target: Readonly<{
        baseUrlSha256: string;
        workspaceIdSha256: string;
        projectIdSha256: string;
        assetIdSha256: string | null;
        assetVersionIdSha256: string;
        admissionIdSha256: string | null;
        modelSha256: string;
    }>;
    release: ReleaseEvidence;
    admission: Readonly<{
        status: string;
        subjectKind: string | null;
        complianceState: string | null;
        providerSyncState: string | null;
        identityState: string | null;
        revision: number | null;
    }>;
    provider: ProviderEvidence;
    authorization: Readonly<{
        status: "not_applicable" | "not_started" | "awaiting_manual_h5" | "verified_active";
        authorizationUrlSha256: string | null;
        expiresAt: number | null;
        handoffStatus: "not_applicable" | "not_written" | "atomic_0600_written";
    }>;
    permissions: Readonly<{
        paid: "explicitly_armed";
        production: "explicitly_armed";
    }>;
    http: readonly HttpStageReceipt[];
    secrets: Readonly<{
        providerCredentialsAccepted: false;
        providerCredentialsPrinted: false;
        sessionCredentialsPrinted: false;
        rawIdentifiersPrinted: false;
        rawProviderPayloadPersisted: false;
    }>;
}>;
export type PortraitLiveSmokeDependencies = Readonly<{
    fetch: typeof fetch;
    now: () => number;
    sleep: (milliseconds: number) => Promise<void>;
    readKeychainSecret: (service: string, account: string) => string;
    writeH5Handoff?: (contents: string) => void;
}>;
export declare function parsePortraitLiveSmokeCommand(args: readonly string[], environment?: NodeJS.ProcessEnv): PortraitLiveSmokeCommand;
export declare function runPortraitLiveSmoke(command: Extract<PortraitLiveSmokeCommand, {
    kind: "run";
}>, dependencies?: PortraitLiveSmokeDependencies): Promise<PortraitLiveSmokeReceipt>;
type AtomicPrivateTarget = Readonly<{
    publish: (contents: string) => string;
    dispose: () => void;
}>;
/** Reserve a 0600 temp inode before network activity, then publish via link(2). */
export declare function prepareAtomicPrivateTarget(targetPath: string): AtomicPrivateTarget;
export declare function buildPortraitLiveSmokeSelfCheck(): Readonly<Record<string, unknown>>;
export {};
