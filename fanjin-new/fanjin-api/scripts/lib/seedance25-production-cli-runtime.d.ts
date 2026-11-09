import type { Knex } from "knex";
import { type StrictActivatedReleaseIdentity } from "../../src/lib/releaseIdentity";
export type Seedance25ProductionOperatorEntrypoint = "stage" | "certify" | "certify-seedream45";
interface Seedance25ProductionFilesystemOptions {
    productionBase?: string;
    trustedOwnerUids?: readonly number[];
    trustedRuntimeGids?: readonly number[];
    effectiveUid?: number;
    /** Test-only hook used to prove the stable-read fail-closed boundary. */
    afterInitialFileStat?: (filePath: string) => void;
}
export interface Seedance25ProductionOperatorEnvironmentInput extends Seedance25ProductionFilesystemOptions {
    apply: boolean;
    environment?: NodeJS.ProcessEnv;
}
export interface Seedance25StrictActivatedReleaseInput extends Seedance25ProductionFilesystemOptions {
    operator: Seedance25ProductionOperatorEntrypoint;
    environment?: NodeJS.ProcessEnv;
    executablePath?: string;
    execArgv?: readonly string[];
}
/** Load the selected file as the authority, never as a fallback to ambient shell values. */
export declare function loadSeedance25ProductionOperatorEnvironment(input: Seedance25ProductionOperatorEnvironmentInput): {
    envFile: string | null;
    loadedKeys: string[];
};
export declare function assertSeedance25ProductionApplyDatabase(database: Knex): void;
export declare function strictSeedance25ActivatedReleaseIdentity(input: Seedance25StrictActivatedReleaseInput): StrictActivatedReleaseIdentity;
export declare function assertSeedance25CertificationReleaseIdentity(input: {
    declaredReleaseId: string;
    declaredSourceCommit: string;
    declaredArtifactSha256: string;
    activated: StrictActivatedReleaseIdentity;
}): void;
export {};
