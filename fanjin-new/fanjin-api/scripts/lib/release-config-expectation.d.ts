import type { Knex } from "knex";
import type { DatabaseMigrationStatus } from "@/lib/databaseMigrations";
import { RELEASE_CANDIDATE_CONFIG_EXPECTATION_FORMAT, RELEASE_CANDIDATE_FREEZE_VERSION } from "./release-candidate-freeze";
export declare const RELEASE_CONFIG_READBACK_FORMAT: "fanjin-production-config-readback/v1";
export declare const RELEASE_CONFIG_EXPECTATION_RESULT_FORMAT: "fanjin-release-config-expectation-result/v1";
export declare const RELEASE_CONFIG_EXPECTED_SCHEMA_VERSION: number;
export declare const RELEASE_CONFIG_BOUNDED_SQLITE_APPLY_AUTHORITY: "formal-candidate-bounded-sqlite/v1";
export type ReleaseConfigExpectationErrorCode = "CONFIG_EXPECTATION_PIN_INVALID" | "CONFIG_JSON_INVALID" | "CONFIG_PROJECTION_UNSUPPORTED" | "CONFIG_SECRET_DETECTED" | "CONFIG_SNAPSHOT_MISMATCH" | "DATABASE_APPLY_UNSAFE" | "DATABASE_CLIENT_UNSUPPORTED" | "DATABASE_ENVIRONMENT_INVALID" | "DATABASE_READ_ONLY_REQUIRED" | "DATABASE_SCHEMA_MISMATCH" | "OUTPUT_PATH_UNSAFE" | "OUTPUT_UNAVAILABLE";
export declare class ReleaseConfigExpectationError extends Error {
    readonly code: ReleaseConfigExpectationErrorCode;
    constructor(code: ReleaseConfigExpectationErrorCode);
}
type Database = Knex | Knex.Transaction;
export interface ReleaseConfigExpectation {
    candidateVersion: typeof RELEASE_CANDIDATE_FREEZE_VERSION;
    expectedReadback: ReleaseConfigExpectedReadback;
    format: typeof RELEASE_CANDIDATE_CONFIG_EXPECTATION_FORMAT;
}
export interface ReleaseConfigExpectedReadback {
    capabilities: Array<Record<string, unknown>>;
    channelBindings: Array<Record<string, unknown>>;
    channelHealth: Array<Record<string, unknown>>;
    databaseIdentitySha256: string;
    format: typeof RELEASE_CONFIG_READBACK_FORMAT;
    healthGateSha256: string;
    modelRoutes: Array<Record<string, unknown>>;
    pricing: Array<Record<string, unknown>>;
    schema: {
        current: true;
        migrationChecksum: string;
        migrationName: string;
        version: typeof RELEASE_CONFIG_EXPECTED_SCHEMA_VERSION;
    };
    snapshotSha256: string;
}
export interface ReleaseConfigExpectationCaptureDependencies {
    databaseIdentitySha256?: string;
    inspectMigrations?: (database: Database) => Promise<Pick<DatabaseMigrationStatus, "applied" | "current" | "databaseVersion" | "knownLatestVersion" | "tableExists">>;
}
/**
 * Load only database-selection variables from an operator-selected private
 * environment file. The selected file is authoritative: ambient database
 * variables are removed before its values are installed.
 */
export declare function loadTrustedReleaseDatabaseEnvironment(filePath: string, environment?: NodeJS.ProcessEnv): void;
export declare function releaseDatabaseIdentitySha256(client: "postgres" | "sqlite", environment?: NodeJS.ProcessEnv): string;
export declare function sha256Canonical(value: unknown): string;
export declare function releaseConfigStableSnapshot(readback: ReleaseConfigExpectedReadback): Omit<ReleaseConfigExpectedReadback, "channelHealth" | "databaseIdentitySha256" | "format" | "healthGateSha256" | "snapshotSha256">;
/** Strict parser used by the formal coordinator before live DB comparison. */
export declare function parseReleaseConfigExpectation(value: unknown): ReleaseConfigExpectation;
/**
 * Reads the exact root-owned expectation pinned by the formal coordinator.
 * Formal root processes use root:root 0400/0600; a hardened non-root service
 * may explicitly pin its primary group and consume only root:<group> 0440.
 * Both byte identity and canonical semantic identity are required so harmless
 * formatting cannot be used to substitute a different production contract.
 */
export declare function readPinnedReleaseConfigExpectation(input: Readonly<{
    file: string;
    rawSha256: string;
    canonicalSha256: string;
    /** Optional read-only service group for a root-owned 0440 runtime copy. */
    trustedGroupGid?: number;
}>): ReleaseConfigExpectation;
export declare function captureReleaseConfigExpectation(database: Database, dependencies?: ReleaseConfigExpectationCaptureDependencies): Promise<ReleaseConfigExpectation>;
export declare function assertReleaseConfigExpectationMatchesSnapshot(database: Database, expectedValue: unknown, dependencies?: ReleaseConfigExpectationCaptureDependencies): Promise<ReleaseConfigExpectation>;
/**
 * Replaces only the three configuration catalogs in the disposable formal
 * candidate SQLite. It cannot run against PostgreSQL and requires an explicit
 * bounded-runtime authority constant at every call site.
 */
export declare function applyReleaseConfigExpectationToBoundedSqlite(transaction: Knex.Transaction, expectedValue: unknown, authority: typeof RELEASE_CONFIG_BOUNDED_SQLITE_APPLY_AUTHORITY, dependencies?: ReleaseConfigExpectationCaptureDependencies): Promise<ReleaseConfigExpectation>;
export declare function writeReleaseConfigExpectation(output: string, expectation: ReleaseConfigExpectation): {
    bytes: number;
    sha256: string;
};
export declare function inReadOnlyReleaseConfigSnapshot<T>(database: Knex, work: (transaction: Knex.Transaction) => Promise<T>): Promise<T>;
export {};
