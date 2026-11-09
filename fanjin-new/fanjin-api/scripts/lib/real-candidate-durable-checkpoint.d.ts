export declare const REAL_CANDIDATE_CHECKPOINT_MANIFEST_FILE = "candidate-checkpoint.json";
export declare const REAL_CANDIDATE_CHECKPOINT_MANIFEST_VERSION = "fanjin-real-candidate-checkpoint/v1";
export declare const REAL_CANDIDATE_CHECKPOINT_DATABASE_FILE = "db2.sqlite";
export declare const REAL_CANDIDATE_CHECKPOINT_SESSION_FILE = "browser-session.json";
export type RealCandidateCheckpointLifecycle = "initializing" | "ready" | "stopped" | "interrupted" | "failed";
export type RealCandidateCheckpointManifest = {
    version: typeof REAL_CANDIDATE_CHECKPOINT_MANIFEST_VERSION;
    lifecycle: RealCandidateCheckpointLifecycle;
    createdAt: string;
    updatedAt: string;
    anonymousBinding: string;
};
export type RealCandidateCheckpointDependencies = {
    homeDirectory?: string;
    now?: () => Date;
    randomBytes?: (size: number) => Buffer;
};
export type RealCandidateCheckpoint = {
    rootDirectory: string;
    dataDirectory: string;
    manifestFile: string;
    manifest: RealCandidateCheckpointManifest;
};
export declare class RealCandidateCheckpointError extends Error {
    readonly code: string;
    constructor(code: string);
}
export declare function realCandidateCheckpointRoot(dependencies?: RealCandidateCheckpointDependencies): string;
export declare function isRealCandidateCheckpointLeafName(name: string): boolean;
export declare function createRealCandidateCheckpoint(requestedDirectory?: string, dependencies?: RealCandidateCheckpointDependencies): RealCandidateCheckpoint;
export declare function validateRealCandidateCheckpointDirectory(dataDirectory: string, dependencies?: RealCandidateCheckpointDependencies): RealCandidateCheckpoint;
export declare function updateRealCandidateCheckpointLifecycle(dataDirectory: string, lifecycle: RealCandidateCheckpointLifecycle, dependencies?: RealCandidateCheckpointDependencies): RealCandidateCheckpointManifest;
export declare function secureRealCandidateCheckpointFile(file: string, code: string): void;
export declare function discardInitializingRealCandidateCheckpoint(dataDirectory: string, dependencies?: RealCandidateCheckpointDependencies): void;
export declare function cleanupTerminalRealCandidateCheckpoint(dataDirectory: string, dependencies?: RealCandidateCheckpointDependencies): void;
