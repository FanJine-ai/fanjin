import { createHash } from "node:crypto";

import {
  defaultReleaseSchemaCompatibility,
  isApprovedAdditiveSchemaWindow,
  parseReleaseSchemaCompatibility,
  ReleaseSchemaCompatibilityError,
  sameReleaseSchemaMigrationEdge,
} from "@/lib/releaseSchemaCompatibility";
import type {
  ReleaseSchemaCompatibility,
  ReleaseSchemaMode,
} from "./types";

export const RELEASE_MIGRATION_MODE_RETIRED_CODE =
  "RELEASE_MIGRATION_MODE_RETIRED_V007" as const;

/**
 * v0.0.7 has one external compatibility contract only:
 * `fanjin-release-schema-compatibility/v1`.
 */
export function exactReleaseSchemaCompatibility(
  schemaVersion: number,
): ReleaseSchemaCompatibility {
  return defaultReleaseSchemaCompatibility(schemaVersion);
}

export function schemaRangeIncludes(
  supportedDatabaseVersions: readonly number[],
  schemaVersion: number,
): boolean {
  return supportedDatabaseVersions.includes(schemaVersion);
}

export function schemaCompatibilitySupports(
  compatibility: ReleaseSchemaCompatibility,
  schemaVersion: number,
): boolean {
  return schemaRangeIncludes(
    compatibility.supportedDatabaseVersions,
    schemaVersion,
  );
}

/**
 * Stable proof shared by runtime/Worker fences. It binds every field in the
 * only accepted v0.0.7 schema contract, including exact migration identity.
 */
export function releaseSchemaCompatibilityProofSha256(
  compatibility: ReleaseSchemaCompatibility,
): string {
  const migration = compatibility.migration;
  return createHash("sha256")
    .update(JSON.stringify([
      compatibility.format,
      compatibility.binarySchemaVersion,
      [...compatibility.supportedDatabaseVersions],
      migration?.fromVersion ?? null,
      migration?.toVersion ?? null,
      migration?.migrationName ?? null,
      migration?.migrationChecksum ?? null,
      migration?.mode ?? null,
      migration?.rollbackMode ?? null,
    ]))
    .digest("hex");
}

/**
 * Parse the sole external contract. T6's former one-shot migration-mode cannot
 * be mapped safely: it starts the target N binary while the database is still
 * N-1, whereas the audited T2 contract deliberately never lets an N binary
 * claim support for N-1. The entry point therefore fails closed in v0.0.7.
 */
export function releaseSchemaCompatibilityError(
  schemaMode: ReleaseSchemaMode,
  schemaVersion: number,
  value: unknown,
): string | null {
  try {
    parseReleaseSchemaCompatibility(value, schemaVersion);
  } catch (error) {
    return error instanceof ReleaseSchemaCompatibilityError
      ? error.message
      : "schemaCompatibility 无效";
  }
  if (schemaMode === "migration") {
    return `${RELEASE_MIGRATION_MODE_RETIRED_CODE}: v0.0.7 已退役单次 migration-mode`;
  }
  return null;
}

/**
 * Semantic N/N+1 bridge check used by dormant guarded migration components.
 * Exact previous/target artifact identity is bound separately by
 * ReleaseSchemaCompatibilityBridgeV1 at every live deployment boundary.
 */
export function migrationBridgeCompatibilityError(
  previousSchemaVersion: number,
  previousCompatibility: ReleaseSchemaCompatibility,
  targetSchemaVersion: number,
  targetCompatibility: ReleaseSchemaCompatibility,
): string | null {
  if (targetSchemaVersion !== previousSchemaVersion + 1) {
    return "schema bridge 只允许相邻 N/N+1 代际";
  }
  const previousMigration = previousCompatibility.migration;
  const targetMigration = targetCompatibility.migration;
  if (
    !previousMigration
    || !targetMigration
    || !sameReleaseSchemaMigrationEdge(previousMigration, targetMigration)
    || !isApprovedAdditiveSchemaWindow(previousMigration)
    || previousMigration.fromVersion !== previousSchemaVersion
    || previousMigration.toVersion !== targetSchemaVersion
  ) {
    return "目标与上一制品未共同声明精确 allowlisted migration identity";
  }
  if (
    previousCompatibility.binarySchemaVersion !== previousSchemaVersion
    || !schemaCompatibilitySupports(previousCompatibility, previousSchemaVersion)
    || !schemaCompatibilitySupports(previousCompatibility, targetSchemaVersion)
  ) {
    return "上一制品缺少 N/N+1 bridge compatibility";
  }
  if (
    targetCompatibility.binarySchemaVersion !== targetSchemaVersion
    || !schemaCompatibilitySupports(targetCompatibility, targetSchemaVersion)
  ) {
    return "目标制品不支持目标数据库 schema";
  }
  return null;
}
