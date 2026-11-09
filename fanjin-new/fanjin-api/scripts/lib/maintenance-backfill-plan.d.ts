import { type MaintenanceWriterQuiescenceProof } from "@/lib/maintenanceWriterQuiescence";
export declare const MAINTENANCE_BACKFILL_APPROVAL: "v0.1.1-schema48-history-portrait-backfills";
export declare const MAINTENANCE_BACKFILL_SCHEMA_VERSION: 48;
export declare const MAINTENANCE_BACKFILL_RECEIPT_FORMAT: "fanjin-0.1.1-maintenance-backfill-receipt/v2";
export declare const MAINTENANCE_BACKFILL_CHECKPOINT_FORMAT: "fanjin-release-migration-backup-checkpoint/v2";
export declare const MAINTENANCE_BACKFILL_RECEIPT_DIRECTORY_ENV: "FANJIN_0_1_1_MAINTENANCE_BACKFILL_RECEIPT_DIR";
export declare const MAINTENANCE_BACKFILL_WRITER_QUIESCENCE_PROOF_FILE_ENV: "FANJIN_0_1_1_MAINTENANCE_WRITER_QUIESCENCE_PROOF_FILE";
export declare const MAINTENANCE_BACKFILL_DEPLOYMENT_ID_ENV: "FANJIN_MAINTENANCE_DEPLOYMENT_ID";
export declare const MAINTENANCE_BACKFILL_ACTIVATION_NONCE_ENV: "FANJIN_MAINTENANCE_ACTIVATION_NONCE";
export declare const MAINTENANCE_BACKFILL_ACTIVATION_NONCE_FILE_ENV: "FANJIN_RELEASE_MAINTENANCE_NONCE_FILE";
export declare const MAINTENANCE_BACKFILL_DATABASE_IDENTITY_ENV: "FANJIN_MAINTENANCE_DATABASE_IDENTITY_SHA256";
export declare const MAINTENANCE_BACKFILL_ALLOWED_DATABASE_ROLES_ENV: "FANJIN_MAINTENANCE_ALLOWED_DATABASE_ROLES";
export declare const MAINTENANCE_BACKFILL_APPLICATION_DATABASE_ROLES_ENV: "FANJIN_MAINTENANCE_APPLICATION_DATABASE_ROLES";
export type MaintenanceBackfillStepId = "schema-48-check" | "history-storage-apply-drain" | "history-storage-check" | "portrait-source-sha-apply-drain" | "portrait-source-sha-check";
export interface MaintenanceBackfillStep {
    id: MaintenanceBackfillStepId;
    entrypoint: string;
    arguments: readonly string[];
    apply: boolean;
}
export interface MaintenanceBackfillRunResult {
    status: number | null;
    signal?: NodeJS.Signals | null;
    error?: Error;
}
export type MaintenanceBackfillRunner = (executable: string, arguments_: readonly string[], options: {
    environment: NodeJS.ProcessEnv;
}) => MaintenanceBackfillRunResult;
export interface MaintenanceBackfillReleaseIdentity {
    runId: string;
    artifactSha256: string;
    sourceCommit: string;
}
export interface MaintenanceBackfillWriterQuiescenceExpectation {
    deploymentId: string;
    nonce: string;
    databaseIdentitySha256: string;
    allowedDatabaseRoles: readonly string[];
    applicationDatabaseRoles: readonly string[];
}
export interface MaintenanceBackfillCheckpointBinding {
    fileName: string;
    contentSha256: string;
    format: typeof MAINTENANCE_BACKFILL_CHECKPOINT_FORMAT;
    checkpointId: string;
    remoteObjectIdentitySha256: string;
    remoteObjectVersionId: string;
    sourceDatabaseIdentitySha256: string;
    verifiedAt: number;
    expiresAt: number;
}
export interface VerifiedMaintenanceBackfillCheckpoint {
    filePath: string;
    binding: MaintenanceBackfillCheckpointBinding;
}
export interface VerifiedMaintenanceWriterQuiescenceProof {
    filePath: string;
    contentSha256: string;
    proof: MaintenanceWriterQuiescenceProof;
}
export interface MaintenanceBackfillReceipt {
    format: typeof MAINTENANCE_BACKFILL_RECEIPT_FORMAT;
    release: "0.1.1";
    schemaVersion: typeof MAINTENANCE_BACKFILL_SCHEMA_VERSION;
    runId: string;
    artifactSha256: string;
    sourceCommit: string;
    checkpoint: MaintenanceBackfillCheckpointBinding;
    approval: typeof MAINTENANCE_BACKFILL_APPROVAL;
    maintenanceWriterQuiescence: MaintenanceWriterQuiescenceProof;
    writeFenceScope: "current-command-and-apply-children-only";
    steps: Array<{
        id: MaintenanceBackfillStepId;
        status: "completed";
    }>;
    completedAt: string;
}
export interface PersistedMaintenanceBackfillReceipt {
    filePath: string;
    contentSha256: string;
    receipt: MaintenanceBackfillReceipt;
}
export declare function maintenanceBackfillReleaseIdentity(environment: NodeJS.ProcessEnv): MaintenanceBackfillReleaseIdentity;
export declare function maintenanceBackfillWriterQuiescenceExpectation(environment: NodeJS.ProcessEnv, nonce: string): MaintenanceBackfillWriterQuiescenceExpectation;
export declare function validateMaintenanceBackfillEnvironment(environment: NodeJS.ProcessEnv, nonce: string): void;
export declare function maintenanceBackfillSteps(buildDirectory: string): MaintenanceBackfillStep[];
export declare function maintenanceBackfillChildEnvironment(environment: NodeJS.ProcessEnv, step: MaintenanceBackfillStep): NodeJS.ProcessEnv;
export declare function maintenanceBackfillReceiptFileName(runId: string): string;
export declare function readAndVerifyMaintenanceBackfillCheckpoint(input: {
    checkpointDirectory: string;
    identity: MaintenanceBackfillReleaseIdentity;
    now?: () => number;
}): VerifiedMaintenanceBackfillCheckpoint;
export declare function readAndVerifyMaintenanceWriterQuiescenceProof(input: {
    proofFile: string;
    expected: MaintenanceBackfillWriterQuiescenceExpectation;
}): VerifiedMaintenanceWriterQuiescenceProof;
export declare function runMaintenanceBackfillPlan(input: {
    environment: NodeJS.ProcessEnv;
    buildDirectory: string;
    executable: string;
    runner: MaintenanceBackfillRunner;
    checkpoint: MaintenanceBackfillCheckpointBinding;
    writerQuiescenceProof: MaintenanceWriterQuiescenceProof;
    now?: () => Date;
}): MaintenanceBackfillReceipt;
export declare function persistMaintenanceBackfillReceipt(input: {
    receiptDirectory: string;
    receipt: MaintenanceBackfillReceipt;
    writerQuiescenceExpected: MaintenanceBackfillWriterQuiescenceExpectation;
    now?: () => number;
}): PersistedMaintenanceBackfillReceipt;
export declare function readAndVerifyMaintenanceBackfillReceipt(input: {
    receiptDirectory: string;
    checkpointDirectory: string;
    identity: MaintenanceBackfillReleaseIdentity;
    writerQuiescenceExpected: MaintenanceBackfillWriterQuiescenceExpectation;
    now?: () => number;
}): PersistedMaintenanceBackfillReceipt;
