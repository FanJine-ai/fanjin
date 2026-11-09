import { type RealCandidateCheckpointDependencies } from "./lib/real-candidate-durable-checkpoint";
export declare const FULL_MATRIX_IMAGE_MATERIALIZE_FLAG = "--checkpoint-materialize-only";
export declare const FULL_MATRIX_IMAGE_MATERIALIZE_ACK_ENV = "FANJIN_REAL_IMAGE_CHECKPOINT_MATERIALIZE_ACK";
export declare const FULL_MATRIX_IMAGE_MATERIALIZE_ACK_VALUE = "I_ACCEPT_ONE_SETTLED_CHECKPOINT_LOCAL_MATERIALIZATION_ZERO_PROVIDER_CALLS";
export declare const FULL_MATRIX_IMAGE_MATERIALIZE_GUARD_SUFFIX = ".image-checkpoint-materialize.started";
export type ImageCheckpointCandidateDirectoryScope = "durable" | "legacy-tmp" | "formal-coordinator-runtime";
export type ImageCheckpointCandidateDirectoryDependencies = RealCandidateCheckpointDependencies & Readonly<{
    platform?: NodeJS.Platform;
    currentUid?: number;
    currentGid?: number;
    runtimeOwnerUid?: number;
    runtimeOwnerGid?: number;
    formalRootUid?: number;
    formalRootGid?: number;
}>;
export declare function imageCheckpointCandidateDatabaseFile(directory: string, _scope: ImageCheckpointCandidateDirectoryScope): string;
export declare function validateImageCheckpointCandidateDirectory(directory: string, checkpointDependencies?: ImageCheckpointCandidateDirectoryDependencies): ImageCheckpointCandidateDirectoryScope;
export type ImageCheckpointFormalDatabaseSeparation = Readonly<{
    recoveryDatabaseFile: string;
    sourceDatabaseFile: string;
}>;
export type ImageCheckpointFormalSourcePin = Readonly<{
    file: string;
    digest: string;
    device: number;
    inode: number;
    size: number;
    mode: number;
    uid: number;
    gid: number;
}>;
export declare function captureImageCheckpointFormalSourcePin(sourceDatabaseFile: string): ImageCheckpointFormalSourcePin;
export declare function reattestImageCheckpointFormalSourcePin(expected: ImageCheckpointFormalSourcePin): void;
export declare function releaseImageCheckpointFormalSourcePin(pin: ImageCheckpointFormalSourcePin): void;
/**
 * The formal coordinator's candidate.sqlite is the immutable input pin. The
 * launched API writes through FANJIN_DATA_DIR/db2.sqlite, so settled recovery
 * must never target candidate.sqlite or an alias of it.
 */
export declare function validateImageCheckpointFormalDatabaseSeparation(directory: string): ImageCheckpointFormalDatabaseSeparation;
/**
 * Read-only proof used before arming the permanent one-shot guard. Importing
 * callers receive counts only; command, session, asset and provider handles
 * remain sealed inside the candidate artifacts.
 */
export declare function preflightFullMatrixImageCheckpointMaterialization(command: {
    sessionFile: string;
    evidenceFile: string;
}): Promise<Record<string, unknown>>;
/**
 * Narrow in-process entry used by the full-matrix driver after Candidate E's
 * intentional HTTP 500. It traverses the same parser/ACK gate and the exact
 * same guarded zero-provider recovery implementation as the standalone CLI.
 */
export declare function materializeFullMatrixImageCheckpoint(input: {
    sessionFile: string;
    evidenceFile: string;
    environment?: NodeJS.ProcessEnv;
}): Promise<Record<string, unknown>>;
