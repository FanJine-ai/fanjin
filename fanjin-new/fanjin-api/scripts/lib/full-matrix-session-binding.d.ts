export declare const FULL_MATRIX_MANIFEST_VERSION = "fanjin-workbench-full-matrix-evidence/v5";
export type FullMatrixSessionBindingInput = {
    workspaceId: string;
    projectId: number;
    userId: number;
    createdAt: string;
    candidateIdentity?: {
        format: string;
        evidenceClass: string;
        formalB0Eligible: boolean;
        runtimeArtifactBindingVerified: boolean;
        freezeReceiptDigest: string;
        freezeSha256: string;
        releaseUuid: string;
        artifactUuid: string;
        artifactSha256: string;
        artifactSignedManifestSha256: string;
        sourceDigest: string;
        configExpectedSha256: string;
        schemaExpectedSha256: string;
        attestationKeyId: string;
    };
};
/**
 * Stable evidence binding shared by the full-matrix verifier and recovery
 * launcher. Keep this module limited to Node built-ins so a long-lived API
 * process does not load either SQLite native addon merely to compute a hash.
 */
export declare function fullMatrixSessionBinding(session: FullMatrixSessionBindingInput): string;
