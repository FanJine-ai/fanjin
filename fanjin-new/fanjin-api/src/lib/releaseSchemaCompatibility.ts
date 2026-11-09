import {
  REFERENCE_DOCUMENT_UPLOAD_MIGRATION_IDENTITY,
  REFERENCE_DOCUMENT_UPLOAD_MIGRATION_CHECKSUM,
  USER_FEEDBACK_MIGRATION_IDENTITY,
  USER_FEEDBACK_MIGRATION_CHECKSUM,
  EXTERNAL_TOOLS_MIGRATION_IDENTITY,
  EXTERNAL_TOOLS_MIGRATION_CHECKSUM,
  ACCOUNT_WORKSPACE_ASSET_LIBRARY_MIGRATION_CHECKSUM,
  ACCOUNT_WORKSPACE_ASSET_LIBRARY_MIGRATION_IDENTITY,
  ACTIVE_PROJECT_TRIGGER_ROW_SHAPE_REPAIR_MIGRATION_CHECKSUM,
  ACTIVE_PROJECT_TRIGGER_ROW_SHAPE_REPAIR_MIGRATION_IDENTITY,
  CANVAS_WORKFLOW_TEMPLATE_MIGRATION_CHECKSUM,
  CANVAS_WORKFLOW_TEMPLATE_MIGRATION_IDENTITY,
  CACHE_STORAGE_ACCRUAL_MIGRATION_CHECKSUM,
  CACHE_STORAGE_ACCRUAL_MIGRATION_IDENTITY,
  DELETION_WORKFLOW_MIGRATION_CHECKSUM,
  DELETION_WORKFLOW_MIGRATION_IDENTITY,
  IDENTITY_AUTHORITY_INTEGRITY_MIGRATION_CHECKSUM,
  IDENTITY_AUTHORITY_INTEGRITY_MIGRATION_IDENTITY,
  MODEL_ROUTE_CERTIFICATION_MIGRATION_CHECKSUM,
  MODEL_ROUTE_CERTIFICATION_MIGRATION_IDENTITY,
  ONLINE_PAYMENT_ORDER_MIGRATION_CHECKSUM,
  ONLINE_PAYMENT_ORDER_MIGRATION_IDENTITY,
  PORTRAIT_ASSET_ADMISSION_MIGRATION_CHECKSUM,
  PORTRAIT_ASSET_ADMISSION_MIGRATION_IDENTITY,
  PORTRAIT_ASSET_REVIEW_RUNTIME_MIGRATION_CHECKSUM,
  PORTRAIT_ASSET_REVIEW_RUNTIME_MIGRATION_IDENTITY,
  PRICING_GROUP_REGISTRY_MIGRATION_CHECKSUM,
  PRICING_GROUP_REGISTRY_MIGRATION_IDENTITY,
  MULTI_TENANT_DOMAIN_ALB_RELEASE_MIGRATION_CHECKSUM,
  MULTI_TENANT_DOMAIN_ALB_RELEASE_MIGRATION_IDENTITY,
  FINANCIAL_DOMAIN_INTEGRITY_MIGRATION_CHECKSUM,
  FINANCIAL_DOMAIN_INTEGRITY_MIGRATION_IDENTITY,
  PROJECT_FOLDERS_MIGRATION_CHECKSUM,
  PROJECT_FOLDERS_MIGRATION_IDENTITY,
  REFERENCE_MULTIPART_UPLOAD_MIGRATION_CHECKSUM,
  REFERENCE_MULTIPART_UPLOAD_MIGRATION_IDENTITY,
  RELEASE_ARTIFACT_GENERATION_MIGRATION_CHECKSUM,
  RELEASE_ARTIFACT_GENERATION_MIGRATION_IDENTITY,
  RELEASE_ARTIFACT_MULTIPART_UPLOAD_MIGRATION_CHECKSUM,
  RELEASE_ARTIFACT_MULTIPART_UPLOAD_MIGRATION_IDENTITY,
  SERVICE_REQUEST_V1_RUNTIME_MIGRATION_CHECKSUM,
  SERVICE_REQUEST_V1_RUNTIME_MIGRATION_IDENTITY,
} from "@/lib/migrationCompatibilityCatalog";

export const RELEASE_SCHEMA_COMPATIBILITY_FORMAT =
  "fanjin-release-schema-compatibility/v1" as const;

export interface ReleaseSchemaMigrationEdgeV1 {
  fromVersion: number;
  toVersion: number;
  migrationName: string;
  migrationChecksum: string;
  mode: "expand";
  rollbackMode: "binary-compatible";
}

/**
 * Signed, per-binary database compatibility declaration.
 *
 * `schemaVersion` remains the binary's native schema generation. A binary may
 * additionally declare support for exactly the next additive generation, but
 * only through an immutable, repository-approved migration edge.
 */
export interface ReleaseSchemaCompatibilityV1 {
  format: typeof RELEASE_SCHEMA_COMPATIBILITY_FORMAT;
  binarySchemaVersion: number;
  supportedDatabaseVersions: readonly number[];
  migration: ReleaseSchemaMigrationEdgeV1 | null;
}

export interface ReleaseSchemaArtifactIdentity {
  releaseId: string;
  sourceCommit: string;
  artifactSha256: string;
  schemaVersion: number;
  schemaCompatibility: ReleaseSchemaCompatibilityV1;
}

/**
 * Controller-owned exact bridge persisted with a deployment. This is derived
 * from both signed manifests; browser input can never construct it.
 */
export interface ReleaseSchemaCompatibilityBridgeV1 {
  format: typeof RELEASE_SCHEMA_COMPATIBILITY_FORMAT;
  previous: {
    releaseId: string;
    sourceCommit: string;
    artifactSha256: string;
    schemaVersion: number;
  };
  target: {
    releaseId: string;
    sourceCommit: string;
    artifactSha256: string;
    schemaVersion: number;
  };
  migration: ReleaseSchemaMigrationEdgeV1;
}

export class ReleaseSchemaCompatibilityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ReleaseSchemaCompatibilityError";
    this.code = code;
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MIGRATION_NAME_PATTERN = /^[a-z][a-z0-9_]{0,127}$/;
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

/**
 * Append-only review allowlist. A migration not named here is never accepted
 * as forward-compatible, even if a signed artifact claims that it is.
 */
export const APPROVED_ADDITIVE_SCHEMA_WINDOWS:
readonly ReleaseSchemaMigrationEdgeV1[] = Object.freeze([
  Object.freeze({
    fromVersion: DELETION_WORKFLOW_MIGRATION_IDENTITY.version - 1,
    toVersion: DELETION_WORKFLOW_MIGRATION_IDENTITY.version,
    migrationName: DELETION_WORKFLOW_MIGRATION_IDENTITY.name,
    migrationChecksum: DELETION_WORKFLOW_MIGRATION_CHECKSUM,
    mode: "expand",
    rollbackMode: "binary-compatible",
  }),
  Object.freeze({
    fromVersion: RELEASE_ARTIFACT_GENERATION_MIGRATION_IDENTITY.version - 1,
    toVersion: RELEASE_ARTIFACT_GENERATION_MIGRATION_IDENTITY.version,
    migrationName: RELEASE_ARTIFACT_GENERATION_MIGRATION_IDENTITY.name,
    migrationChecksum: RELEASE_ARTIFACT_GENERATION_MIGRATION_CHECKSUM,
    mode: "expand",
    rollbackMode: "binary-compatible",
  }),
  Object.freeze({
    fromVersion:
      ACTIVE_PROJECT_TRIGGER_ROW_SHAPE_REPAIR_MIGRATION_IDENTITY.version - 1,
    toVersion:
      ACTIVE_PROJECT_TRIGGER_ROW_SHAPE_REPAIR_MIGRATION_IDENTITY.version,
    migrationName:
      ACTIVE_PROJECT_TRIGGER_ROW_SHAPE_REPAIR_MIGRATION_IDENTITY.name,
    migrationChecksum:
      ACTIVE_PROJECT_TRIGGER_ROW_SHAPE_REPAIR_MIGRATION_CHECKSUM,
    mode: "expand",
    rollbackMode: "binary-compatible",
  }),
  Object.freeze({
    fromVersion:
      IDENTITY_AUTHORITY_INTEGRITY_MIGRATION_IDENTITY.version - 1,
    toVersion: IDENTITY_AUTHORITY_INTEGRITY_MIGRATION_IDENTITY.version,
    migrationName: IDENTITY_AUTHORITY_INTEGRITY_MIGRATION_IDENTITY.name,
    migrationChecksum: IDENTITY_AUTHORITY_INTEGRITY_MIGRATION_CHECKSUM,
    mode: "expand",
    rollbackMode: "binary-compatible",
  }),
  Object.freeze({
    fromVersion: SERVICE_REQUEST_V1_RUNTIME_MIGRATION_IDENTITY.version - 1,
    toVersion: SERVICE_REQUEST_V1_RUNTIME_MIGRATION_IDENTITY.version,
    migrationName: SERVICE_REQUEST_V1_RUNTIME_MIGRATION_IDENTITY.name,
    migrationChecksum: SERVICE_REQUEST_V1_RUNTIME_MIGRATION_CHECKSUM,
    mode: "expand",
    rollbackMode: "binary-compatible",
  }),
  Object.freeze({
    fromVersion: PROJECT_FOLDERS_MIGRATION_IDENTITY.version - 1,
    toVersion: PROJECT_FOLDERS_MIGRATION_IDENTITY.version,
    migrationName: PROJECT_FOLDERS_MIGRATION_IDENTITY.name,
    migrationChecksum: PROJECT_FOLDERS_MIGRATION_CHECKSUM,
    mode: "expand",
    rollbackMode: "binary-compatible",
  }),
  Object.freeze({
    fromVersion: CANVAS_WORKFLOW_TEMPLATE_MIGRATION_IDENTITY.version - 1,
    toVersion: CANVAS_WORKFLOW_TEMPLATE_MIGRATION_IDENTITY.version,
    migrationName: CANVAS_WORKFLOW_TEMPLATE_MIGRATION_IDENTITY.name,
    migrationChecksum: CANVAS_WORKFLOW_TEMPLATE_MIGRATION_CHECKSUM,
    mode: "expand",
    rollbackMode: "binary-compatible",
  }),
  Object.freeze({
    fromVersion:
      RELEASE_ARTIFACT_MULTIPART_UPLOAD_MIGRATION_IDENTITY.version - 1,
    toVersion: RELEASE_ARTIFACT_MULTIPART_UPLOAD_MIGRATION_IDENTITY.version,
    migrationName: RELEASE_ARTIFACT_MULTIPART_UPLOAD_MIGRATION_IDENTITY.name,
    migrationChecksum:
      RELEASE_ARTIFACT_MULTIPART_UPLOAD_MIGRATION_CHECKSUM,
    mode: "expand",
    rollbackMode: "binary-compatible",
  }),
  Object.freeze({
    fromVersion: MODEL_ROUTE_CERTIFICATION_MIGRATION_IDENTITY.version - 1,
    toVersion: MODEL_ROUTE_CERTIFICATION_MIGRATION_IDENTITY.version,
    migrationName: MODEL_ROUTE_CERTIFICATION_MIGRATION_IDENTITY.name,
    migrationChecksum: MODEL_ROUTE_CERTIFICATION_MIGRATION_CHECKSUM,
    mode: "expand",
    rollbackMode: "binary-compatible",
  }),
  Object.freeze({
    fromVersion: CACHE_STORAGE_ACCRUAL_MIGRATION_IDENTITY.version - 1,
    toVersion: CACHE_STORAGE_ACCRUAL_MIGRATION_IDENTITY.version,
    migrationName: CACHE_STORAGE_ACCRUAL_MIGRATION_IDENTITY.name,
    migrationChecksum: CACHE_STORAGE_ACCRUAL_MIGRATION_CHECKSUM,
    mode: "expand",
    rollbackMode: "binary-compatible",
  }),
  Object.freeze({
    fromVersion: REFERENCE_MULTIPART_UPLOAD_MIGRATION_IDENTITY.version - 1,
    toVersion: REFERENCE_MULTIPART_UPLOAD_MIGRATION_IDENTITY.version,
    migrationName: REFERENCE_MULTIPART_UPLOAD_MIGRATION_IDENTITY.name,
    migrationChecksum: REFERENCE_MULTIPART_UPLOAD_MIGRATION_CHECKSUM,
    mode: "expand",
    rollbackMode: "binary-compatible",
  }),
  Object.freeze({
    fromVersion: ONLINE_PAYMENT_ORDER_MIGRATION_IDENTITY.version - 1,
    toVersion: ONLINE_PAYMENT_ORDER_MIGRATION_IDENTITY.version,
    migrationName: ONLINE_PAYMENT_ORDER_MIGRATION_IDENTITY.name,
    migrationChecksum: ONLINE_PAYMENT_ORDER_MIGRATION_CHECKSUM,
    mode: "expand",
    rollbackMode: "binary-compatible",
  }),
  Object.freeze({
    fromVersion: PORTRAIT_ASSET_ADMISSION_MIGRATION_IDENTITY.version - 1,
    toVersion: PORTRAIT_ASSET_ADMISSION_MIGRATION_IDENTITY.version,
    migrationName: PORTRAIT_ASSET_ADMISSION_MIGRATION_IDENTITY.name,
    migrationChecksum: PORTRAIT_ASSET_ADMISSION_MIGRATION_CHECKSUM,
    mode: "expand",
    rollbackMode: "binary-compatible",
  }),
  Object.freeze({
    fromVersion: PORTRAIT_ASSET_REVIEW_RUNTIME_MIGRATION_IDENTITY.version - 1,
    toVersion: PORTRAIT_ASSET_REVIEW_RUNTIME_MIGRATION_IDENTITY.version,
    migrationName: PORTRAIT_ASSET_REVIEW_RUNTIME_MIGRATION_IDENTITY.name,
    migrationChecksum: PORTRAIT_ASSET_REVIEW_RUNTIME_MIGRATION_CHECKSUM,
    mode: "expand",
    rollbackMode: "binary-compatible",
  }),
  Object.freeze({
    fromVersion: ACCOUNT_WORKSPACE_ASSET_LIBRARY_MIGRATION_IDENTITY.version - 1,
    toVersion: ACCOUNT_WORKSPACE_ASSET_LIBRARY_MIGRATION_IDENTITY.version,
    migrationName: ACCOUNT_WORKSPACE_ASSET_LIBRARY_MIGRATION_IDENTITY.name,
    migrationChecksum: ACCOUNT_WORKSPACE_ASSET_LIBRARY_MIGRATION_CHECKSUM,
    mode: "expand",
    rollbackMode: "binary-compatible",
  }),
  Object.freeze({
    fromVersion: PRICING_GROUP_REGISTRY_MIGRATION_IDENTITY.version - 1,
    toVersion: PRICING_GROUP_REGISTRY_MIGRATION_IDENTITY.version,
    migrationName: PRICING_GROUP_REGISTRY_MIGRATION_IDENTITY.name,
    migrationChecksum: PRICING_GROUP_REGISTRY_MIGRATION_CHECKSUM,
    mode: "expand",
    rollbackMode: "binary-compatible",
  }),
  Object.freeze({
    fromVersion: MULTI_TENANT_DOMAIN_ALB_RELEASE_MIGRATION_IDENTITY.version - 1,
    toVersion: MULTI_TENANT_DOMAIN_ALB_RELEASE_MIGRATION_IDENTITY.version,
    migrationName: MULTI_TENANT_DOMAIN_ALB_RELEASE_MIGRATION_IDENTITY.name,
    migrationChecksum: MULTI_TENANT_DOMAIN_ALB_RELEASE_MIGRATION_CHECKSUM,
    mode: "expand",
    rollbackMode: "binary-compatible",
  }),
  Object.freeze({
    fromVersion: FINANCIAL_DOMAIN_INTEGRITY_MIGRATION_IDENTITY.version - 1,
    toVersion: FINANCIAL_DOMAIN_INTEGRITY_MIGRATION_IDENTITY.version,
    migrationName: FINANCIAL_DOMAIN_INTEGRITY_MIGRATION_IDENTITY.name,
    migrationChecksum: FINANCIAL_DOMAIN_INTEGRITY_MIGRATION_CHECKSUM,
    mode: "expand",
    rollbackMode: "binary-compatible",
  }),
  // Reviewed separately from the historical contiguous 34–52 window.
  Object.freeze({
    fromVersion: 58, toVersion: EXTERNAL_TOOLS_MIGRATION_IDENTITY.version,
    migrationName: EXTERNAL_TOOLS_MIGRATION_IDENTITY.name,
    migrationChecksum: EXTERNAL_TOOLS_MIGRATION_CHECKSUM,
    mode: "expand", rollbackMode: "binary-compatible",
  }),
  Object.freeze({
    fromVersion: 59, toVersion: USER_FEEDBACK_MIGRATION_IDENTITY.version,
    migrationName: USER_FEEDBACK_MIGRATION_IDENTITY.name,
    migrationChecksum: USER_FEEDBACK_MIGRATION_CHECKSUM,
    mode: "expand", rollbackMode: "binary-compatible",
  }),
  Object.freeze({ fromVersion: 60, toVersion: REFERENCE_DOCUMENT_UPLOAD_MIGRATION_IDENTITY.version,
    migrationName: REFERENCE_DOCUMENT_UPLOAD_MIGRATION_IDENTITY.name, migrationChecksum: REFERENCE_DOCUMENT_UPLOAD_MIGRATION_CHECKSUM,
    mode: "expand", rollbackMode: "binary-compatible" }),
]);

function fail(code: string, message: string): never {
  throw new ReleaseSchemaCompatibilityError(code, message);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("RELEASE_SCHEMA_COMPATIBILITY_INVALID", `${label} 必须是 JSON object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  object: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  if (Object.keys(object).some((key) => !expected.has(key))
    || keys.some((key) => !Object.prototype.hasOwnProperty.call(object, key))) {
    fail("RELEASE_SCHEMA_COMPATIBILITY_INVALID", `${label} 字段集合无效`);
  }
}

function schemaVersion(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2_147_483_647) {
    fail("RELEASE_SCHEMA_COMPATIBILITY_INVALID", `${label} 必须是正整数 schema 代际`);
  }
  return Number(value);
}

function parseMigrationEdge(value: unknown): ReleaseSchemaMigrationEdgeV1 {
  const object = objectValue(value, "schemaCompatibility.migration");
  exactKeys(object, [
    "fromVersion",
    "toVersion",
    "migrationName",
    "migrationChecksum",
    "mode",
    "rollbackMode",
  ], "schemaCompatibility.migration");
  const fromVersion = schemaVersion(object.fromVersion, "migration.fromVersion");
  const toVersion = schemaVersion(object.toVersion, "migration.toVersion");
  if (toVersion !== fromVersion + 1) {
    fail(
      "RELEASE_SCHEMA_COMPATIBILITY_NOT_N_MINUS_ONE",
      "schema compatibility 只允许相邻 N/N-1 代际",
    );
  }
  if (typeof object.migrationName !== "string"
    || !MIGRATION_NAME_PATTERN.test(object.migrationName)) {
    fail("RELEASE_SCHEMA_COMPATIBILITY_INVALID", "migrationName 格式无效");
  }
  if (typeof object.migrationChecksum !== "string"
    || !SHA256_PATTERN.test(object.migrationChecksum)) {
    fail("RELEASE_SCHEMA_COMPATIBILITY_INVALID", "migrationChecksum 格式无效");
  }
  if (object.mode !== "expand") {
    fail(
      "RELEASE_SCHEMA_MIGRATION_MODE_UNSUPPORTED",
      "只允许明确声明的 additive expand migration",
    );
  }
  if (object.rollbackMode !== "binary-compatible") {
    fail(
      "RELEASE_SCHEMA_ROLLBACK_MODE_UNSUPPORTED",
      "跨代际回切必须明确声明 binary-compatible",
    );
  }
  const edge: ReleaseSchemaMigrationEdgeV1 = {
    fromVersion,
    toVersion,
    migrationName: object.migrationName,
    migrationChecksum: object.migrationChecksum,
    mode: "expand",
    rollbackMode: "binary-compatible",
  };
  if (!isApprovedAdditiveSchemaWindow(edge)) {
    fail(
      "RELEASE_SCHEMA_MIGRATION_NOT_ALLOWLISTED",
      "migration 未进入不可变 additive compatibility allowlist",
    );
  }
  return edge;
}

export function sameReleaseSchemaMigrationEdge(
  left: ReleaseSchemaMigrationEdgeV1,
  right: ReleaseSchemaMigrationEdgeV1,
): boolean {
  return left.fromVersion === right.fromVersion
    && left.toVersion === right.toVersion
    && left.migrationName === right.migrationName
    && left.migrationChecksum === right.migrationChecksum
    && left.mode === right.mode
    && left.rollbackMode === right.rollbackMode;
}

export function isApprovedAdditiveSchemaWindow(
  edge: ReleaseSchemaMigrationEdgeV1,
): boolean {
  return APPROVED_ADDITIVE_SCHEMA_WINDOWS.some((approved) => (
    sameReleaseSchemaMigrationEdge(approved, edge)
  ));
}

export function defaultReleaseSchemaCompatibility(
  binarySchemaVersion: number,
): ReleaseSchemaCompatibilityV1 {
  const version = schemaVersion(binarySchemaVersion, "schemaVersion");
  return {
    format: RELEASE_SCHEMA_COMPATIBILITY_FORMAT,
    binarySchemaVersion: version,
    supportedDatabaseVersions: [version],
    migration: null,
  };
}

export function parseReleaseSchemaCompatibility(
  value: unknown,
  manifestSchemaVersion: number,
): ReleaseSchemaCompatibilityV1 {
  const binaryVersion = schemaVersion(manifestSchemaVersion, "manifest.schemaVersion");
  if (value === undefined) return defaultReleaseSchemaCompatibility(binaryVersion);
  const object = objectValue(value, "manifest.schemaCompatibility");
  exactKeys(object, [
    "format",
    "binarySchemaVersion",
    "supportedDatabaseVersions",
    "migration",
  ], "manifest.schemaCompatibility");
  if (object.format !== RELEASE_SCHEMA_COMPATIBILITY_FORMAT) {
    fail("RELEASE_SCHEMA_COMPATIBILITY_INVALID", "schemaCompatibility.format 不受支持");
  }
  if (schemaVersion(object.binarySchemaVersion, "binarySchemaVersion") !== binaryVersion) {
    fail(
      "RELEASE_SCHEMA_BINARY_VERSION_MISMATCH",
      "schemaCompatibility.binarySchemaVersion 与 manifest.schemaVersion 不一致",
    );
  }
  if (!Array.isArray(object.supportedDatabaseVersions)
    || object.supportedDatabaseVersions.length < 1
    || object.supportedDatabaseVersions.length > 2) {
    fail(
      "RELEASE_SCHEMA_COMPATIBILITY_INVALID",
      "supportedDatabaseVersions 必须包含一到两个相邻代际",
    );
  }
  const supportedDatabaseVersions = object.supportedDatabaseVersions.map(
    (entry, index) => schemaVersion(entry, `supportedDatabaseVersions[${index}]`),
  );
  if (new Set(supportedDatabaseVersions).size !== supportedDatabaseVersions.length
    || supportedDatabaseVersions.some((entry, index) => (
      index > 0 && entry !== supportedDatabaseVersions[index - 1] + 1
    ))
    || supportedDatabaseVersions[0] !== binaryVersion
    || supportedDatabaseVersions.at(-1)! > binaryVersion + 1) {
    fail(
      "RELEASE_SCHEMA_COMPATIBILITY_NOT_N_MINUS_ONE",
      "binary 只可声明原生代际及紧邻的下一 additive 代际",
    );
  }
  const migration = object.migration === null ? null : parseMigrationEdge(object.migration);
  if (supportedDatabaseVersions.length === 2) {
    if (!migration
      || migration.fromVersion !== binaryVersion
      || migration.toVersion !== binaryVersion + 1) {
      fail(
        "RELEASE_SCHEMA_COMPATIBILITY_EDGE_MISSING",
        "forward-compatible binary 必须绑定对应的 allowlisted expand migration",
      );
    }
  }
  if (migration
    && migration.fromVersion !== binaryVersion
    && migration.toVersion !== binaryVersion) {
    fail(
      "RELEASE_SCHEMA_COMPATIBILITY_EDGE_UNRELATED",
      "migration edge 必须与 binary schema 代际相邻",
    );
  }
  return {
    format: RELEASE_SCHEMA_COMPATIBILITY_FORMAT,
    binarySchemaVersion: binaryVersion,
    supportedDatabaseVersions,
    migration,
  };
}

function validIdentity(identity: ReleaseSchemaArtifactIdentity, label: string): void {
  if (!RELEASE_ID_PATTERN.test(identity.releaseId)
    || !SOURCE_COMMIT_PATTERN.test(identity.sourceCommit)
    || !SHA256_PATTERN.test(identity.artifactSha256)
    || identity.schemaCompatibility.binarySchemaVersion !== identity.schemaVersion) {
    fail("RELEASE_SCHEMA_ARTIFACT_IDENTITY_INVALID", `${label} artifact identity 无效`);
  }
}

function supportsDatabase(
  compatibility: ReleaseSchemaCompatibilityV1,
  databaseVersion: number,
): boolean {
  return compatibility.supportedDatabaseVersions.includes(databaseVersion);
}

export function resolveReleaseSchemaCompatibilityBridge(input: {
  previous: ReleaseSchemaArtifactIdentity;
  target: ReleaseSchemaArtifactIdentity;
  databaseVersion: number;
}): ReleaseSchemaCompatibilityBridgeV1 | null {
  validIdentity(input.previous, "previous");
  validIdentity(input.target, "target");
  const databaseVersion = schemaVersion(input.databaseVersion, "databaseVersion");
  if (input.target.schemaVersion !== databaseVersion
    || !supportsDatabase(input.target.schemaCompatibility, databaseVersion)) {
    fail(
      "RELEASE_TARGET_SCHEMA_UNSUPPORTED",
      "目标 binary 未声明支持当前数据库 schema",
    );
  }
  if (input.previous.schemaVersion === input.target.schemaVersion) {
    if (!supportsDatabase(input.previous.schemaCompatibility, databaseVersion)) {
      fail(
        "RELEASE_PREVIOUS_SCHEMA_UNSUPPORTED",
        "上一 binary 未声明支持当前数据库 schema",
      );
    }
    return null;
  }
  if (input.target.schemaVersion !== input.previous.schemaVersion + 1) {
    fail(
      "RELEASE_SCHEMA_COMPATIBILITY_NOT_N_MINUS_ONE",
      "滚动发布只允许同代际或 N/N-1 additive bridge",
    );
  }
  const previousMigration = input.previous.schemaCompatibility.migration;
  const targetMigration = input.target.schemaCompatibility.migration;
  if (!supportsDatabase(input.previous.schemaCompatibility, databaseVersion)
    || !previousMigration
    || !targetMigration
    || !sameReleaseSchemaMigrationEdge(previousMigration, targetMigration)
    || previousMigration.fromVersion !== input.previous.schemaVersion
    || previousMigration.toVersion !== input.target.schemaVersion
    || !isApprovedAdditiveSchemaWindow(previousMigration)) {
    fail(
      "RELEASE_SCHEMA_COMPATIBILITY_UNDECLARED",
      "旧、新 binary 未共同声明受审的 additive schema bridge",
    );
  }
  return {
    format: RELEASE_SCHEMA_COMPATIBILITY_FORMAT,
    previous: {
      releaseId: input.previous.releaseId,
      sourceCommit: input.previous.sourceCommit,
      artifactSha256: input.previous.artifactSha256,
      schemaVersion: input.previous.schemaVersion,
    },
    target: {
      releaseId: input.target.releaseId,
      sourceCommit: input.target.sourceCommit,
      artifactSha256: input.target.artifactSha256,
      schemaVersion: input.target.schemaVersion,
    },
    migration: { ...previousMigration },
  };
}

export function assertReleaseSchemaCompatibilityBridge(
  bridge: ReleaseSchemaCompatibilityBridgeV1,
): void {
  if (!bridge || bridge.format !== RELEASE_SCHEMA_COMPATIBILITY_FORMAT) {
    fail("RELEASE_SCHEMA_BRIDGE_INVALID", "schema bridge 格式无效");
  }
  const previousCompatibility: ReleaseSchemaCompatibilityV1 = {
    format: RELEASE_SCHEMA_COMPATIBILITY_FORMAT,
    binarySchemaVersion: bridge.previous.schemaVersion,
    supportedDatabaseVersions: [
      bridge.previous.schemaVersion,
      bridge.target.schemaVersion,
    ],
    migration: bridge.migration,
  };
  const targetCompatibility: ReleaseSchemaCompatibilityV1 = {
    format: RELEASE_SCHEMA_COMPATIBILITY_FORMAT,
    binarySchemaVersion: bridge.target.schemaVersion,
    supportedDatabaseVersions: [bridge.target.schemaVersion],
    migration: bridge.migration,
  };
  const resolved = resolveReleaseSchemaCompatibilityBridge({
    previous: { ...bridge.previous, schemaCompatibility: previousCompatibility },
    target: { ...bridge.target, schemaCompatibility: targetCompatibility },
    databaseVersion: bridge.target.schemaVersion,
  });
  if (!resolved || JSON.stringify(resolved) !== JSON.stringify(bridge)) {
    fail("RELEASE_SCHEMA_BRIDGE_INVALID", "schema bridge identity 不一致");
  }
}

export function expectedPreviousSchemaVersion(input: {
  targetSchemaVersion: number;
  targetArtifactSha256: string;
  bridge?: ReleaseSchemaCompatibilityBridgeV1 | null;
}): number {
  if (!input.bridge) return input.targetSchemaVersion;
  assertReleaseSchemaCompatibilityBridge(input.bridge);
  if (input.bridge.target.schemaVersion !== input.targetSchemaVersion
    || input.bridge.target.artifactSha256 !== input.targetArtifactSha256) {
    fail("RELEASE_SCHEMA_BRIDGE_TARGET_MISMATCH", "schema bridge 与目标制品不匹配");
  }
  return input.bridge.previous.schemaVersion;
}
