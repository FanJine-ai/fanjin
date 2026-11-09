import { upReferenceDocumentUpload, downReferenceDocumentUpload } from "@/lib/migrations/referenceDocumentUpload";
import { upExternalTools, downExternalTools } from "@/lib/migrations/externalTools";
import { FILE_MANAGER_CONSTRAINTS, upAssetFileManager, downAssetFileManager } from "@/lib/migrations/assetFileManager";
import { downUserFeedback, upUserFeedback, USER_FEEDBACK_REQUIRED_CONSTRAINTS } from "@/lib/migrations/userFeedback";
import { upPortraitAutomaticRegistration, downPortraitAutomaticRegistration } from "@/lib/migrations/portraitAutomaticRegistration";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Knex } from "knex";
import { MEDIA_SERVICE_TABLE, MEDIA_SERVICES_MIGRATION_IDENTITY, upMediaServices, downMediaServices } from "@/lib/migrations/mediaServices";
import { OBJECT_WRITE_ABSENCE_AUDIT_TABLE, OBJECT_WRITE_ABSENCE_MIGRATION_IDENTITY, upObjectWriteAbsenceReconciliation, downObjectWriteAbsenceReconciliation } from "@/lib/migrations/objectWriteAbsenceReconciliation";
import { MEMBERSHIP_REQUIRED_CONSTRAINTS, upMembershipEntitlements, downMembershipEntitlements } from "@/lib/migrations/membershipEntitlements";
import { RESOURCE_CONSTRAINTS, upMembershipResources, downMembershipResources } from "@/lib/migrations/membershipResources";
import { isPostgresClient, tableColumns } from "@/lib/dbDialect";
import {
  downRelayCallbackSecretEnvelope,
  upRelayCallbackSecretEnvelope,
} from "@/lib/migrations/relayCallbackSecretEnvelope";
import {
  downUserPasswordHistoryPolicy,
  upUserPasswordHistoryPolicy,
} from "@/lib/migrations/userPasswordHistoryPolicy";
import {
  downRemoveVendorSecretLogging,
  upRemoveVendorSecretLogging,
} from "@/lib/migrations/removeVendorSecretLogging";
import {
  downRetentionCleanupIndexes,
  upRetentionCleanupIndexes,
} from "@/lib/migrations/retentionCleanupIndexes";
import { downMfaTotp, upMfaTotp } from "@/lib/migrations/mfaTotp";
import {
  downCreationSession,
  upCreationSession,
} from "@/lib/migrations/creationSession";
import {
  downAgentRoleConfig,
  upAgentRoleConfig,
} from "@/lib/migrations/agentRoleConfig";
import {
  downAgentApprovalDelegation,
  upAgentApprovalDelegation,
} from "@/lib/migrations/agentApprovalDelegation";
import {
  downProjectRevision,
  upProjectRevision,
} from "@/lib/migrations/projectRevision";
import {
  downCreationSessionMutation,
  upCreationSessionMutation,
} from "@/lib/migrations/creationSessionMutation";
import {
  downAgentGenerationQuote,
  upAgentGenerationQuote,
} from "@/lib/migrations/agentGenerationQuote";
import {
  downAgentRunRecoveryCount,
  upAgentRunRecoveryCount,
} from "@/lib/migrations/agentRunRecoveryCount";
import {
  downAgentApprovalConsumedStep,
  upAgentApprovalConsumedStep,
} from "@/lib/migrations/agentApprovalConsumedStep";
import {
  downAgentApprovalArgumentsSummary,
  upAgentApprovalArgumentsSummary,
} from "@/lib/migrations/agentApprovalArgumentsSummary";
import {
  downAgentDelegationTaskResult,
  upAgentDelegationTaskResult,
} from "@/lib/migrations/agentDelegationTaskResult";
import {
  downAgentReviewReport,
  upAgentReviewReport,
} from "@/lib/migrations/agentReviewReport";
import {
  downCanvasCommandMutation,
  upCanvasCommandMutation,
} from "@/lib/migrations/canvasCommandMutation";
import {
  downOperationalRuntimeSchema,
  upOperationalRuntimeSchema,
} from "@/lib/migrations/operationalRuntimeSchema";
import {
  downResponsesResourceBinding,
  upResponsesResourceBinding,
} from "@/lib/migrations/responsesResourceBinding";
import {
  downPlatformRelease,
  upPlatformRelease,
} from "@/lib/migrations/platformRelease";
import {
  downEmailVerifiedAt,
  upEmailVerifiedAt,
} from "@/lib/migrations/emailVerifiedAt";
import {
  downEnforceUnifiedProjectCanvas,
  downUnifiedProjectCanvas,
  upEnforceUnifiedProjectCanvas,
  upUnifiedProjectCanvas,
} from "@/lib/migrations/unifiedProjectCanvas";
import {
  downAgentProjectBudget,
  upAgentProjectBudget,
} from "@/lib/migrations/agentProjectBudget";
import {
  downAgentGenerationReview,
  upAgentGenerationReview,
} from "@/lib/migrations/agentGenerationReview";
import {
  downCanvasAsset,
  upCanvasAsset,
} from "@/lib/migrations/canvasAsset";
import {
  downUserOauthIdentity,
  upUserOauthIdentity,
} from "@/lib/migrations/userOauthIdentity";
import {
  downModelRouteDisplayName,
  upModelRouteDisplayName,
} from "@/lib/migrations/modelRouteDisplayName";
import {
  downVideoFulfillmentRecipe,
  upVideoFulfillmentRecipe,
} from "@/lib/migrations/videoFulfillmentRecipe";
import {
  downUserVideoEnhanceTask,
  upUserVideoEnhanceTask,
} from "@/lib/migrations/userVideoEnhanceTask";
import {
  downProjectFolders,
  PROJECT_FOLDER_TABLE,
  upProjectFolders,
} from "@/lib/migrations/projectFolders";
import {
  downReleaseDeploymentOrchestration,
  upReleaseDeploymentOrchestration,
} from "@/lib/migrations/releaseDeploymentOrchestration";
import {
  downReleaseDeploymentReconciliation,
  upReleaseDeploymentReconciliation,
} from "@/lib/migrations/releaseDeploymentReconciliation";
import {
  downActiveProjectTriggerRowShapeRepair,
  upActiveProjectTriggerRowShapeRepair,
} from "@/lib/migrations/activeProjectTriggerRowShapeRepair";
import {
  downIdentityAuthorityIntegrity,
  IDENTITY_AUTHORITY_REQUIRED_CONSTRAINTS,
  upIdentityAuthorityIntegrity,
} from "@/lib/migrations/identityAuthorityIntegrity";
import {
  downServiceRequestV1Runtime,
  SERVICE_REQUEST_V1_REQUIRED_CONSTRAINTS,
  upServiceRequestV1Runtime,
} from "@/lib/migrations/serviceRequestV1Runtime";
import {
  DELETION_OPERATION_TABLE,
  DELETION_RESOURCE_ALIAS_TABLE,
  downDeletionWorkflow,
  upDeletionWorkflow,
} from "@/lib/migrations/deletionWorkflow";
import {
  CANVAS_WORKFLOW_TEMPLATE_MIGRATION_IDENTITY,
  CACHE_STORAGE_ACCRUAL_MIGRATION_IDENTITY,
  ACTIVE_PROJECT_TRIGGER_ROW_SHAPE_REPAIR_MIGRATION_IDENTITY,
  DELETION_WORKFLOW_MIGRATION_IDENTITY,
  IDENTITY_AUTHORITY_INTEGRITY_MIGRATION_IDENTITY,
  MODEL_ROUTE_CERTIFICATION_MIGRATION_IDENTITY,
  PROJECT_FOLDERS_MIGRATION_IDENTITY,
  RELEASE_ARTIFACT_GENERATION_MIGRATION_IDENTITY,
  RELEASE_ARTIFACT_MULTIPART_UPLOAD_MIGRATION_IDENTITY,
  REFERENCE_MULTIPART_UPLOAD_MIGRATION_IDENTITY,
  ONLINE_PAYMENT_ORDER_MIGRATION_IDENTITY,
  PORTRAIT_ASSET_ADMISSION_MIGRATION_IDENTITY,
  PORTRAIT_ASSET_REVIEW_RUNTIME_MIGRATION_IDENTITY,
  ACCOUNT_WORKSPACE_ASSET_LIBRARY_MIGRATION_IDENTITY,
  PRICING_GROUP_REGISTRY_MIGRATION_IDENTITY,
  MULTI_TENANT_DOMAIN_ALB_RELEASE_MIGRATION_IDENTITY,
  FINANCIAL_DOMAIN_INTEGRITY_MIGRATION_IDENTITY,
  SERVICE_REQUEST_V1_RUNTIME_MIGRATION_IDENTITY,
} from "@/lib/migrationCompatibilityCatalog";
import {
  ACCOUNT_WORKSPACE_ASSET_LIBRARY_REQUIRED_CONSTRAINTS,
  downAccountWorkspaceAssetLibrary,
  upAccountWorkspaceAssetLibrary,
} from "@/lib/migrations/accountWorkspaceAssetLibrary";
import {
  downOnlinePaymentOrder,
  ONLINE_PAYMENT_ORDER_REQUIRED_CONSTRAINTS,
  upOnlinePaymentOrder,
} from "@/lib/migrations/onlinePaymentOrder";
import {
  downPortraitAssetAdmissionV47,
  PORTRAIT_ASSET_ADMISSION_V47_REQUIRED_CONSTRAINTS,
  upPortraitAssetAdmissionV47,
} from "@/lib/migrations/portraitAssetAdmissionV47";
import {
  downPortraitAssetReviewRuntime,
  PORTRAIT_ASSET_REVIEW_RUNTIME_REQUIRED_CONSTRAINTS,
  upPortraitAssetReviewRuntime,
} from "@/lib/migrations/portraitAssetReviewRuntime";
import {
  downPricingGroupRegistry,
  PRICING_GROUP_REGISTRY_REQUIRED_CONSTRAINTS,
  upPricingGroupRegistry,
} from "@/lib/migrations/pricingGroupRegistry";
import {
  downMultiTenantDomainAlbRelease,
  MULTI_TENANT_DOMAIN_ALB_RELEASE_REQUIRED_CONSTRAINTS,
  upMultiTenantDomainAlbRelease,
} from "@/lib/migrations/multiTenantDomainAlbRelease";
import {
  downFinancialDomainIntegrity,
  FINANCIAL_DOMAIN_INTEGRITY_REQUIRED_CONSTRAINTS,
  upFinancialDomainIntegrity,
} from "@/lib/migrations/financialDomainIntegrity";
import {
  CACHE_STORAGE_ACCRUAL_REQUIRED_CONSTRAINTS,
  downCacheStorageAccrual,
  upCacheStorageAccrual,
} from "@/lib/migrations/cacheStorageAccrual";
import {
  downReferenceMultipartUpload,
  REFERENCE_MULTIPART_UPLOAD_REQUIRED_CONSTRAINTS,
  upReferenceMultipartUpload,
} from "@/lib/migrations/referenceMultipartUpload";
import {
  CANVAS_WORKFLOW_TEMPLATE_REQUIRED_CONSTRAINTS,
  downCanvasWorkflowTemplate,
  upCanvasWorkflowTemplate,
} from "@/lib/migrations/canvasWorkflowTemplate";
import {
  RELEASE_ARTIFACT_GENERATION_INDEXES,
  RELEASE_ARTIFACT_UPLOAD_RESERVATION_INDEXES,
  RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE,
  downReleaseArtifactGeneration,
  upReleaseArtifactGeneration,
} from "@/lib/migrations/releaseArtifactGeneration";
import {
  downReleaseArtifactMultipartUpload,
  RELEASE_ARTIFACT_MULTIPART_UPLOAD_REQUIRED_CONSTRAINTS,
  upReleaseArtifactMultipartUpload,
} from "@/lib/migrations/releaseArtifactMultipartUpload";
import {
  downModelRouteCertification,
  MODEL_ROUTE_CERTIFICATION_REQUIRED_CONSTRAINTS,
  upModelRouteCertification,
} from "@/lib/migrations/modelRouteCertification";
import {
  isApprovedAdditiveSchemaWindow,
  parseReleaseSchemaCompatibility,
  sameReleaseSchemaMigrationEdge,
  type ReleaseSchemaCompatibilityV1,
} from "@/lib/releaseSchemaCompatibility";

export const SCHEMA_MIGRATION_TABLE = "o_schema_migration";
export const SCHEMA_MIGRATION_RUN_TABLE = "o_schema_migration_run";
const SQLITE_MIGRATION_LOCK_TABLE = "o_schema_migration_lock";
export const POSTGRES_MIGRATION_LOCK_SQL =
  "SELECT pg_try_advisory_xact_lock(?) AS acquired";
export const POSTGRES_MIGRATION_TRANSACTION_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(?)";
export const POSTGRES_MIGRATION_LOCK_KEY = 1_817_631_921;
export const POSTGRES_MIGRATION_DEFAULT_LOCK_TIMEOUT_MS = 5_000;
export const POSTGRES_MIGRATION_DEFAULT_STATEMENT_TIMEOUT_MS = 900_000;
export const POSTGRES_MIGRATION_MAX_LOCK_TIMEOUT_MS = 60_000;
export const POSTGRES_MIGRATION_MAX_STATEMENT_TIMEOUT_MS = 3_600_000;

export const DATABASE_MIGRATION_ERROR_CODES = {
  ABORTED: "MIGRATION_ABORTED",
  BACKUP_CHECKPOINT_INVALID: "MIGRATION_BACKUP_CHECKPOINT_INVALID",
  BACKUP_CHECKPOINT_REQUIRED: "MIGRATION_BACKUP_CHECKPOINT_REQUIRED",
  EVIDENCE_PERSIST_FAILED: "MIGRATION_EVIDENCE_PERSIST_FAILED",
  EXECUTION_FAILED: "MIGRATION_EXECUTION_FAILED",
  HISTORY_CHANGED: "MIGRATION_HISTORY_CHANGED_DURING_PREFLIGHT",
  OUTCOME_UNKNOWN: "MIGRATION_COMMIT_OUTCOME_UNKNOWN",
  LOCK_TIMEOUT: "MIGRATION_LOCK_TIMEOUT",
  OVERALL_TIMEOUT: "MIGRATION_OVERALL_TIMEOUT",
  RECOVERY_EVIDENCE_REQUIRED: "MIGRATION_RECOVERY_EVIDENCE_REQUIRED",
  SHARED_ROLLBACK_REFUSED: "MIGRATION_SHARED_ROLLBACK_REFUSED",
  SCHEMA_VERIFICATION_FAILED: "MIGRATION_SCHEMA_VERIFICATION_FAILED",
  SCHEMA_VERIFICATION_REQUIRED: "MIGRATION_SCHEMA_VERIFICATION_REQUIRED",
  STATEMENT_TIMEOUT: "MIGRATION_STATEMENT_TIMEOUT",
} as const;

export type DatabaseMigrationErrorCode =
  (typeof DATABASE_MIGRATION_ERROR_CODES)[keyof typeof DATABASE_MIGRATION_ERROR_CODES];

export interface DatabaseMigration {
  version: number;
  name: string;
  checksum: string;
  /**
   * Reviewed schema invariants that must be present after this definition.
   * Release-controller migration mode refuses pending definitions that omit
   * this allowlist; legacy already-applied definitions remain compatible.
   */
  requiredConstraints?: readonly string[];
  up: (trx: Knex.Transaction) => Promise<void>;
  down?: (trx: Knex.Transaction) => Promise<void>;
}

export interface AppliedDatabaseMigration {
  version: number;
  name: string;
  checksum: string;
  appliedAt: number;
}

export interface DatabaseMigrationStatus {
  tableExists: boolean;
  current: boolean;
  applied: AppliedDatabaseMigration[];
  pending: Array<Pick<DatabaseMigration, "version" | "name" | "checksum">>;
  latestVersion: number;
  /** Actual highest applied database version, including an approved N+1 row. */
  databaseVersion: number;
  /** Highest migration implementation compiled into this binary. */
  knownLatestVersion: number;
  /** True only when a signed runtime declaration covers the exact DB history. */
  runtimeCompatible: boolean;
}

export interface DatabaseRuntimeSchemaCompatibility {
  binarySchemaVersion: number;
  schemaCompatibility: ReleaseSchemaCompatibilityV1;
}

export interface DatabaseMigrationInspectionOptions {
  runtimeCompatibility?: DatabaseRuntimeSchemaCompatibility | null;
}

/**
 * A deliberately narrow exception for an already-authorized N-1 runtime.
 *
 * Callers must obtain this from the release runtime attestation gate. It does
 * not permit gaps, partial suffixes, N+1, or a registry whose known tip is not
 * the attested fromVersion.
 */
export interface DatabaseMigrationForwardCompatibility {
  contractVersion: "fanjin-database-forward-compatibility.v1";
  fromVersion: number;
  toVersion: number;
}

export interface InspectDatabaseMigrationOptions
  extends DatabaseMigrationInspectionOptions {
  /**
   * Retained only so dormant T6 guarded-migrator callers fail closed instead
   * of losing their checkpoint shape. It no longer authorizes an unknown
   * migration suffix; the signed T2 runtimeCompatibility declaration does.
   */
  forwardCompatibility?: DatabaseMigrationForwardCompatibility;
}

export interface EnvironmentLike {
  [key: string]: string | undefined;
}

export interface MigrationRunnerClock {
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

export interface MigrationRunnerTimeouts {
  lockTimeoutMs: number;
  lockPollIntervalMs: number;
  statementTimeoutMs: number;
  idleInTransactionTimeoutMs: number;
  overallTimeoutMs: number;
}

export interface MigrationSafetyContext {
  runId: string;
  sourceCommit: string;
  operatorIdentity: string;
  fromVersion: number;
  toVersion: number;
  appliedChecksumChain: string;
  checksumChain: string;
  pending: ReadonlyArray<Pick<DatabaseMigration, "version" | "name" | "checksum">>;
}

export interface VerifiedMigrationBackupCheckpoint {
  checkpointId: string;
  sourceCommit: string;
  schemaVersion: number;
  checksumChain: string;
  schemaFingerprint: string;
  evidenceDigest: string;
  verifiedAt: number;
}

export interface MigrationSchemaVerification {
  fingerprint: string;
  validatedConstraints: readonly string[];
}

export interface MigrationSafetyHooks {
  createVerifiedBackupCheckpoint?: (
    context: MigrationSafetyContext,
  ) => Promise<VerifiedMigrationBackupCheckpoint>;
  verifySchema?: (
    client: Knex | Knex.Transaction,
    context: MigrationSafetyContext & {
      phase: "before" | "after";
      expectedVersion: number;
      requiredConstraints: readonly string[];
    },
  ) => Promise<MigrationSchemaVerification>;
}

export interface RunDatabaseMigrationOptions {
  runId?: string;
  sourceCommit?: string;
  operatorIdentity?: string;
  requireSafetyHooks?: boolean;
  /** Backwards-compatible critical invariants required in both phases. */
  requiredConstraints?: readonly string[];
  requiredConstraintsBefore?: readonly string[];
  requiredConstraintsAfter?: readonly string[];
  hooks?: MigrationSafetyHooks;
  signal?: AbortSignal;
  clock?: MigrationRunnerClock;
  timeouts?: Partial<MigrationRunnerTimeouts>;
}

export interface RollbackDatabaseMigrationOptions {
  steps?: number;
  migrations?: readonly DatabaseMigration[];
  environment?: EnvironmentLike;
  allowSharedEnvironmentRollback?: boolean;
  verifiedBackupCheckpointId?: string;
  restoreDrillId?: string;
}

export interface DatabaseMigrationRunEvidence {
  evidenceId: string;
  runId: string;
  eventOrdinal: 0 | 1;
  sourceCommit: string;
  operatorIdentity: string;
  fromVersion: number;
  toVersion: number;
  checksumChain: string;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  status: "started" | "succeeded" | "failed";
  failedVersion: number | null;
  failureCode: string | null;
  safeError: string | null;
  backupCheckpointId: string | null;
  beforeSchemaFingerprint: string | null;
  afterSchemaFingerprint: string | null;
}

export interface PostgresMigrationTimeouts {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

export class DatabaseMigrationError extends Error {
  readonly code: DatabaseMigrationErrorCode | string;

  constructor(
    message: string,
    code: DatabaseMigrationErrorCode | string = DATABASE_MIGRATION_ERROR_CODES.EXECUTION_FAILED,
  ) {
    super(message);
    this.name = "DatabaseMigrationError";
    this.code = code;
  }
}

export function migrationChecksum(version: number, name: string, immutableRevision: string): string {
  return crypto.createHash("sha256").update(`${version}:${name}:${immutableRevision}`).digest("hex");
}

const BASELINE_VERSION = 1;
const BASELINE_NAME = "legacy_init_and_fix_baseline";
const CALLBACK_SECRET_ENVELOPE_VERSION = 2;
const CALLBACK_SECRET_ENVELOPE_NAME = "relay_callback_secret_envelope";
const AUTH_LOGIN_STATE_VERSION = 3;
const AUTH_LOGIN_STATE_NAME = "auth_login_state";
const USER_PASSWORD_HISTORY_VERSION = 4;
const USER_PASSWORD_HISTORY_NAME = "user_password_history_policy";
const REMOVE_VENDOR_SECRET_LOGGING_VERSION = 5;
const REMOVE_VENDOR_SECRET_LOGGING_NAME = "remove_vendor_secret_logging";
const RETENTION_CLEANUP_INDEXES_VERSION = 6;
const RETENTION_CLEANUP_INDEXES_NAME = "retention_cleanup_indexes";
const MFA_TOTP_VERSION = 7;
const MFA_TOTP_NAME = "mfa_totp";
const CREATION_SESSION_VERSION = 8;
const CREATION_SESSION_NAME = "creation_session";
const AGENT_ROLE_CONFIG_VERSION = 9;
const AGENT_ROLE_CONFIG_NAME = "agent_role_config";
const AGENT_APPROVAL_DELEGATION_VERSION = 10;
const AGENT_APPROVAL_DELEGATION_NAME = "agent_approval_delegation";
const PROJECT_REVISION_VERSION = 11;
const PROJECT_REVISION_NAME = "project_revision";
const CREATION_SESSION_MUTATION_VERSION = 12;
const CREATION_SESSION_MUTATION_NAME = "creation_session_mutation";
const AGENT_GENERATION_QUOTE_VERSION = 13;
const AGENT_GENERATION_QUOTE_NAME = "agent_generation_quote";
const AGENT_RUN_RECOVERY_COUNT_VERSION = 14;
const AGENT_RUN_RECOVERY_COUNT_NAME = "agent_run_recovery_count";
const AGENT_APPROVAL_CONSUMED_STEP_VERSION = 15;
const AGENT_APPROVAL_CONSUMED_STEP_NAME = "agent_approval_consumed_step";
const AGENT_DELEGATION_TASK_RESULT_VERSION = 16;
const AGENT_DELEGATION_TASK_RESULT_NAME = "agent_delegation_task_result";
const AGENT_REVIEW_REPORT_VERSION = 17;
const AGENT_REVIEW_REPORT_NAME = "agent_review_report";
const CANVAS_COMMAND_MUTATION_VERSION = 18;
const CANVAS_COMMAND_MUTATION_NAME = "canvas_command_mutation";
const OPERATIONAL_RUNTIME_SCHEMA_VERSION = 19;
const OPERATIONAL_RUNTIME_SCHEMA_NAME = "operational_runtime_schema";
const RESPONSES_RESOURCE_BINDING_VERSION = 20;
const RESPONSES_RESOURCE_BINDING_NAME = "responses_resource_binding";
const PLATFORM_RELEASE_VERSION = 21;
const PLATFORM_RELEASE_NAME = "platform_release";
const EMAIL_VERIFIED_AT_VERSION = 22;
const EMAIL_VERIFIED_AT_NAME = "email_verified_at";
const UNIFIED_PROJECT_CANVAS_VERSION = 23;
const UNIFIED_PROJECT_CANVAS_NAME = "unified_project_canvas";
const ENFORCE_UNIFIED_PROJECT_CANVAS_VERSION = 24;
const ENFORCE_UNIFIED_PROJECT_CANVAS_NAME = "enforce_unified_project_canvas";
const AGENT_APPROVAL_ARGUMENTS_SUMMARY_VERSION = 25;
const AGENT_APPROVAL_ARGUMENTS_SUMMARY_NAME = "agent_approval_arguments_summary";
const AGENT_PROJECT_BUDGET_VERSION = 26;
const AGENT_PROJECT_BUDGET_NAME = "agent_project_budget";
const AGENT_GENERATION_REVIEW_VERSION = 27;
const AGENT_GENERATION_REVIEW_NAME = "agent_generation_review";
const CANVAS_ASSET_VERSION = 28;
const CANVAS_ASSET_NAME = "canvas_asset";
const USER_OAUTH_IDENTITY_VERSION = 29;
const USER_OAUTH_IDENTITY_NAME = "user_oauth_identity";
const MODEL_ROUTE_DISPLAY_NAME_VERSION = 30;
const MODEL_ROUTE_DISPLAY_NAME_NAME = "model_route_display_name";
const VIDEO_FULFILLMENT_RECIPE_VERSION = 31;
const VIDEO_FULFILLMENT_RECIPE_NAME = "video_fulfillment_recipe";
const USER_VIDEO_ENHANCE_TASK_VERSION = 32;
const USER_VIDEO_ENHANCE_TASK_NAME = "user_video_enhance_task";
const PROJECT_FOLDERS_VERSION = PROJECT_FOLDERS_MIGRATION_IDENTITY.version;
const PROJECT_FOLDERS_NAME = PROJECT_FOLDERS_MIGRATION_IDENTITY.name;
const RELEASE_DEPLOYMENT_ORCHESTRATION_VERSION = 33;
const RELEASE_DEPLOYMENT_ORCHESTRATION_NAME = "release_deployment_orchestration";
const RELEASE_DEPLOYMENT_RECONCILIATION_VERSION = 34;
const RELEASE_DEPLOYMENT_RECONCILIATION_NAME = "release_deployment_reconciliation";
const DELETION_WORKFLOW_VERSION = DELETION_WORKFLOW_MIGRATION_IDENTITY.version;
const DELETION_WORKFLOW_NAME = DELETION_WORKFLOW_MIGRATION_IDENTITY.name;
const RELEASE_ARTIFACT_GENERATION_VERSION =
  RELEASE_ARTIFACT_GENERATION_MIGRATION_IDENTITY.version;
const RELEASE_ARTIFACT_GENERATION_NAME =
  RELEASE_ARTIFACT_GENERATION_MIGRATION_IDENTITY.name;
const ACTIVE_PROJECT_TRIGGER_ROW_SHAPE_REPAIR_VERSION =
  ACTIVE_PROJECT_TRIGGER_ROW_SHAPE_REPAIR_MIGRATION_IDENTITY.version;
const ACTIVE_PROJECT_TRIGGER_ROW_SHAPE_REPAIR_NAME =
  ACTIVE_PROJECT_TRIGGER_ROW_SHAPE_REPAIR_MIGRATION_IDENTITY.name;
const IDENTITY_AUTHORITY_INTEGRITY_VERSION =
  IDENTITY_AUTHORITY_INTEGRITY_MIGRATION_IDENTITY.version;
const IDENTITY_AUTHORITY_INTEGRITY_NAME =
  IDENTITY_AUTHORITY_INTEGRITY_MIGRATION_IDENTITY.name;
const SERVICE_REQUEST_V1_RUNTIME_VERSION =
  SERVICE_REQUEST_V1_RUNTIME_MIGRATION_IDENTITY.version;
const SERVICE_REQUEST_V1_RUNTIME_NAME =
  SERVICE_REQUEST_V1_RUNTIME_MIGRATION_IDENTITY.name;
const CANVAS_WORKFLOW_TEMPLATE_VERSION =
  CANVAS_WORKFLOW_TEMPLATE_MIGRATION_IDENTITY.version;
const CANVAS_WORKFLOW_TEMPLATE_NAME =
  CANVAS_WORKFLOW_TEMPLATE_MIGRATION_IDENTITY.name;
const RELEASE_ARTIFACT_MULTIPART_UPLOAD_VERSION =
  RELEASE_ARTIFACT_MULTIPART_UPLOAD_MIGRATION_IDENTITY.version;
const RELEASE_ARTIFACT_MULTIPART_UPLOAD_NAME =
  RELEASE_ARTIFACT_MULTIPART_UPLOAD_MIGRATION_IDENTITY.name;
const MODEL_ROUTE_CERTIFICATION_VERSION =
  MODEL_ROUTE_CERTIFICATION_MIGRATION_IDENTITY.version;
const MODEL_ROUTE_CERTIFICATION_NAME =
  MODEL_ROUTE_CERTIFICATION_MIGRATION_IDENTITY.name;
const CACHE_STORAGE_ACCRUAL_VERSION =
  CACHE_STORAGE_ACCRUAL_MIGRATION_IDENTITY.version;
const CACHE_STORAGE_ACCRUAL_NAME =
  CACHE_STORAGE_ACCRUAL_MIGRATION_IDENTITY.name;
const REFERENCE_MULTIPART_UPLOAD_VERSION =
  REFERENCE_MULTIPART_UPLOAD_MIGRATION_IDENTITY.version;
const REFERENCE_MULTIPART_UPLOAD_NAME =
  REFERENCE_MULTIPART_UPLOAD_MIGRATION_IDENTITY.name;
const ONLINE_PAYMENT_ORDER_VERSION = ONLINE_PAYMENT_ORDER_MIGRATION_IDENTITY.version;
const ONLINE_PAYMENT_ORDER_NAME = ONLINE_PAYMENT_ORDER_MIGRATION_IDENTITY.name;
const PORTRAIT_ASSET_ADMISSION_VERSION =
  PORTRAIT_ASSET_ADMISSION_MIGRATION_IDENTITY.version;
const PORTRAIT_ASSET_ADMISSION_NAME =
  PORTRAIT_ASSET_ADMISSION_MIGRATION_IDENTITY.name;
const PORTRAIT_ASSET_REVIEW_RUNTIME_VERSION =
  PORTRAIT_ASSET_REVIEW_RUNTIME_MIGRATION_IDENTITY.version;
const PORTRAIT_ASSET_REVIEW_RUNTIME_NAME =
  PORTRAIT_ASSET_REVIEW_RUNTIME_MIGRATION_IDENTITY.name;
const ACCOUNT_WORKSPACE_ASSET_LIBRARY_VERSION =
  ACCOUNT_WORKSPACE_ASSET_LIBRARY_MIGRATION_IDENTITY.version;
const ACCOUNT_WORKSPACE_ASSET_LIBRARY_NAME =
  ACCOUNT_WORKSPACE_ASSET_LIBRARY_MIGRATION_IDENTITY.name;
const PRICING_GROUP_REGISTRY_VERSION = PRICING_GROUP_REGISTRY_MIGRATION_IDENTITY.version;
const PRICING_GROUP_REGISTRY_NAME = PRICING_GROUP_REGISTRY_MIGRATION_IDENTITY.name;
const PRICING_GROUP_REGISTRY_CHECKSUM = migrationChecksum(
  PRICING_GROUP_REGISTRY_VERSION,
  PRICING_GROUP_REGISTRY_NAME,
  PRICING_GROUP_REGISTRY_MIGRATION_IDENTITY.immutableRevision,
);
const MULTI_TENANT_DOMAIN_ALB_RELEASE_VERSION = MULTI_TENANT_DOMAIN_ALB_RELEASE_MIGRATION_IDENTITY.version;
const MULTI_TENANT_DOMAIN_ALB_RELEASE_NAME = MULTI_TENANT_DOMAIN_ALB_RELEASE_MIGRATION_IDENTITY.name;
const FINANCIAL_DOMAIN_INTEGRITY_VERSION = FINANCIAL_DOMAIN_INTEGRITY_MIGRATION_IDENTITY.version;
const FINANCIAL_DOMAIN_INTEGRITY_NAME = FINANCIAL_DOMAIN_INTEGRITY_MIGRATION_IDENTITY.name;

/**
 * The immutable v50 edge reconciles a ledger version whose schema invariants
 * are already owned by v49. Keep this exception bound to the exact reviewed
 * implementation; arbitrary empty allowlists must continue to fail closed.
 */
export function isReviewedConstraintlessDatabaseMigration(
  definition: DatabaseMigration,
): boolean {
  return (
    definition.version === PRICING_GROUP_REGISTRY_VERSION
    && definition.name === PRICING_GROUP_REGISTRY_NAME
    && definition.checksum === PRICING_GROUP_REGISTRY_CHECKSUM
    && Array.isArray(definition.requiredConstraints)
    && definition.requiredConstraints.length === 0
    && definition.up === upPricingGroupRegistry
    && definition.down === downPricingGroupRegistry
  );
}

export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
  {
    version: BASELINE_VERSION,
    name: BASELINE_NAME,
    // Never edit a released migration in place. Add a new version instead.
    checksum: migrationChecksum(BASELINE_VERSION, BASELINE_NAME, "2026-07-11.1"),
    up: async (trx) => {
      // Lazy imports avoid pulling legacy seed helpers (some of which read the
      // singleton database) into migration status checks.
      const [{ default: initDB }, { default: fixDB }] = await Promise.all([
        import("@/lib/initDB"),
        import("@/lib/fixDB"),
      ]);
      await initDB(trx);
      await fixDB(trx);
    },
    down: async () => {
      throw new DatabaseMigrationError(
        "Migration 1 (legacy baseline) is irreversible and cannot be rolled back without destroying application data.",
      );
    },
  },
  {
    version: CALLBACK_SECRET_ENVELOPE_VERSION,
    name: CALLBACK_SECRET_ENVELOPE_NAME,
    checksum: migrationChecksum(
      CALLBACK_SECRET_ENVELOPE_VERSION,
      CALLBACK_SECRET_ENVELOPE_NAME,
      "2026-07-11.1",
    ),
    up: upRelayCallbackSecretEnvelope,
    down: downRelayCallbackSecretEnvelope,
  },
  {
    version: AUTH_LOGIN_STATE_VERSION,
    name: AUTH_LOGIN_STATE_NAME,
    checksum: migrationChecksum(AUTH_LOGIN_STATE_VERSION, AUTH_LOGIN_STATE_NAME, "2026-07-11.1"),
    up: async (trx) => {
      if (await trx.schema.hasTable("o_auth_login_state")) return;
      await trx.schema.createTable("o_auth_login_state", (table) => {
        table.text("identityHash").notNullable().primary();
        table.bigInteger("userId");
        table.bigInteger("failedCount").notNullable().defaultTo(0);
        table.bigInteger("windowStartedAt").notNullable();
        table.bigInteger("lockedUntil");
        table.bigInteger("lastFailedAt");
        table.bigInteger("updatedAt").notNullable();
        table.index(["userId"]);
        table.index(["lockedUntil"]);
        table.index(["updatedAt"]);
      });
    },
    down: async () => {
      throw new DatabaseMigrationError(
        "Migration 3 (auth login state) cannot be rolled back safely because lockout history and a baseline-owned table must not be deleted.",
      );
    },
  },
  {
    version: USER_PASSWORD_HISTORY_VERSION,
    name: USER_PASSWORD_HISTORY_NAME,
    checksum: migrationChecksum(USER_PASSWORD_HISTORY_VERSION, USER_PASSWORD_HISTORY_NAME, "2026-07-11.1"),
    up: upUserPasswordHistoryPolicy,
    down: downUserPasswordHistoryPolicy,
  },
  {
    version: REMOVE_VENDOR_SECRET_LOGGING_VERSION,
    name: REMOVE_VENDOR_SECRET_LOGGING_NAME,
    checksum: migrationChecksum(
      REMOVE_VENDOR_SECRET_LOGGING_VERSION,
      REMOVE_VENDOR_SECRET_LOGGING_NAME,
      "2026-07-11.1",
    ),
    up: upRemoveVendorSecretLogging,
    down: downRemoveVendorSecretLogging,
  },
  {
    version: RETENTION_CLEANUP_INDEXES_VERSION,
    name: RETENTION_CLEANUP_INDEXES_NAME,
    checksum: migrationChecksum(
      RETENTION_CLEANUP_INDEXES_VERSION,
      RETENTION_CLEANUP_INDEXES_NAME,
      "2026-07-11.1",
    ),
    up: upRetentionCleanupIndexes,
    down: downRetentionCleanupIndexes,
  },
  {
    version: MFA_TOTP_VERSION,
    name: MFA_TOTP_NAME,
    checksum: migrationChecksum(MFA_TOTP_VERSION, MFA_TOTP_NAME, "2026-07-11.1"),
    up: upMfaTotp,
    down: downMfaTotp,
  },
  {
    version: CREATION_SESSION_VERSION,
    name: CREATION_SESSION_NAME,
    checksum: migrationChecksum(
      CREATION_SESSION_VERSION,
      CREATION_SESSION_NAME,
      "2026-07-12.1",
    ),
    up: upCreationSession,
    down: downCreationSession,
  },
  {
    version: AGENT_ROLE_CONFIG_VERSION,
    name: AGENT_ROLE_CONFIG_NAME,
    checksum: migrationChecksum(
      AGENT_ROLE_CONFIG_VERSION,
      AGENT_ROLE_CONFIG_NAME,
      "2026-07-12.1",
    ),
    up: upAgentRoleConfig,
    down: downAgentRoleConfig,
  },
  {
    version: AGENT_APPROVAL_DELEGATION_VERSION,
    name: AGENT_APPROVAL_DELEGATION_NAME,
    checksum: migrationChecksum(
      AGENT_APPROVAL_DELEGATION_VERSION,
      AGENT_APPROVAL_DELEGATION_NAME,
      "2026-07-12.1",
    ),
    up: upAgentApprovalDelegation,
    down: downAgentApprovalDelegation,
  },
  {
    version: PROJECT_REVISION_VERSION,
    name: PROJECT_REVISION_NAME,
    checksum: migrationChecksum(
      PROJECT_REVISION_VERSION,
      PROJECT_REVISION_NAME,
      "2026-07-12.1",
    ),
    up: upProjectRevision,
    down: downProjectRevision,
  },
  {
    version: CREATION_SESSION_MUTATION_VERSION,
    name: CREATION_SESSION_MUTATION_NAME,
    checksum: migrationChecksum(
      CREATION_SESSION_MUTATION_VERSION,
      CREATION_SESSION_MUTATION_NAME,
      "2026-07-13.1",
    ),
    up: upCreationSessionMutation,
    down: downCreationSessionMutation,
  },
  {
    version: AGENT_GENERATION_QUOTE_VERSION,
    name: AGENT_GENERATION_QUOTE_NAME,
    checksum: migrationChecksum(
      AGENT_GENERATION_QUOTE_VERSION,
      AGENT_GENERATION_QUOTE_NAME,
      "2026-07-13.1",
    ),
    up: upAgentGenerationQuote,
    down: downAgentGenerationQuote,
  },
  {
    version: AGENT_RUN_RECOVERY_COUNT_VERSION,
    name: AGENT_RUN_RECOVERY_COUNT_NAME,
    checksum: migrationChecksum(
      AGENT_RUN_RECOVERY_COUNT_VERSION,
      AGENT_RUN_RECOVERY_COUNT_NAME,
      "2026-07-13.1",
    ),
    up: upAgentRunRecoveryCount,
    down: downAgentRunRecoveryCount,
  },
  {
    version: AGENT_APPROVAL_CONSUMED_STEP_VERSION,
    name: AGENT_APPROVAL_CONSUMED_STEP_NAME,
    checksum: migrationChecksum(
      AGENT_APPROVAL_CONSUMED_STEP_VERSION,
      AGENT_APPROVAL_CONSUMED_STEP_NAME,
      "2026-07-13.1",
    ),
    up: upAgentApprovalConsumedStep,
    down: downAgentApprovalConsumedStep,
  },
  {
    version: AGENT_DELEGATION_TASK_RESULT_VERSION,
    name: AGENT_DELEGATION_TASK_RESULT_NAME,
    checksum: migrationChecksum(
      AGENT_DELEGATION_TASK_RESULT_VERSION,
      AGENT_DELEGATION_TASK_RESULT_NAME,
      "2026-07-13.1",
    ),
    up: upAgentDelegationTaskResult,
    down: downAgentDelegationTaskResult,
  },
  {
    version: AGENT_REVIEW_REPORT_VERSION,
    name: AGENT_REVIEW_REPORT_NAME,
    checksum: migrationChecksum(
      AGENT_REVIEW_REPORT_VERSION,
      AGENT_REVIEW_REPORT_NAME,
      "2026-07-13.1",
    ),
    up: upAgentReviewReport,
    down: downAgentReviewReport,
  },
  {
    version: CANVAS_COMMAND_MUTATION_VERSION,
    name: CANVAS_COMMAND_MUTATION_NAME,
    checksum: migrationChecksum(
      CANVAS_COMMAND_MUTATION_VERSION,
      CANVAS_COMMAND_MUTATION_NAME,
      "2026-07-13.1",
    ),
    up: upCanvasCommandMutation,
    down: downCanvasCommandMutation,
  },
  {
    version: OPERATIONAL_RUNTIME_SCHEMA_VERSION,
    name: OPERATIONAL_RUNTIME_SCHEMA_NAME,
    checksum: migrationChecksum(
      OPERATIONAL_RUNTIME_SCHEMA_VERSION,
      OPERATIONAL_RUNTIME_SCHEMA_NAME,
      "2026-07-13.1",
    ),
    up: upOperationalRuntimeSchema,
    down: downOperationalRuntimeSchema,
  },
  {
    version: RESPONSES_RESOURCE_BINDING_VERSION,
    name: RESPONSES_RESOURCE_BINDING_NAME,
    checksum: migrationChecksum(
      RESPONSES_RESOURCE_BINDING_VERSION,
      RESPONSES_RESOURCE_BINDING_NAME,
      "2026-07-14.2",
    ),
    up: upResponsesResourceBinding,
    down: downResponsesResourceBinding,
  },
  {
    version: PLATFORM_RELEASE_VERSION,
    name: PLATFORM_RELEASE_NAME,
    checksum: migrationChecksum(
      PLATFORM_RELEASE_VERSION,
      PLATFORM_RELEASE_NAME,
      "2026-07-15.1",
    ),
    up: upPlatformRelease,
    down: downPlatformRelease,
  },
  {
    version: EMAIL_VERIFIED_AT_VERSION,
    name: EMAIL_VERIFIED_AT_NAME,
    checksum: migrationChecksum(
      EMAIL_VERIFIED_AT_VERSION,
      EMAIL_VERIFIED_AT_NAME,
      "2026-07-16.1",
    ),
    up: upEmailVerifiedAt,
    down: downEmailVerifiedAt,
  },
  {
    version: UNIFIED_PROJECT_CANVAS_VERSION,
    name: UNIFIED_PROJECT_CANVAS_NAME,
    checksum: migrationChecksum(
      UNIFIED_PROJECT_CANVAS_VERSION,
      UNIFIED_PROJECT_CANVAS_NAME,
      "2026-07-17.1",
    ),
    up: upUnifiedProjectCanvas,
    down: downUnifiedProjectCanvas,
  },
  {
    version: ENFORCE_UNIFIED_PROJECT_CANVAS_VERSION,
    name: ENFORCE_UNIFIED_PROJECT_CANVAS_NAME,
    checksum: migrationChecksum(
      ENFORCE_UNIFIED_PROJECT_CANVAS_VERSION,
      ENFORCE_UNIFIED_PROJECT_CANVAS_NAME,
      "2026-07-17.1",
    ),
    up: upEnforceUnifiedProjectCanvas,
    down: downEnforceUnifiedProjectCanvas,
  },
  {
    version: AGENT_APPROVAL_ARGUMENTS_SUMMARY_VERSION,
    name: AGENT_APPROVAL_ARGUMENTS_SUMMARY_NAME,
    checksum: migrationChecksum(
      AGENT_APPROVAL_ARGUMENTS_SUMMARY_VERSION,
      AGENT_APPROVAL_ARGUMENTS_SUMMARY_NAME,
      "2026-07-17.2",
    ),
    up: upAgentApprovalArgumentsSummary,
    down: downAgentApprovalArgumentsSummary,
  },
  {
    version: AGENT_PROJECT_BUDGET_VERSION,
    name: AGENT_PROJECT_BUDGET_NAME,
    checksum: migrationChecksum(
      AGENT_PROJECT_BUDGET_VERSION,
      AGENT_PROJECT_BUDGET_NAME,
      "2026-07-17.3",
    ),
    up: upAgentProjectBudget,
    down: downAgentProjectBudget,
  },
  {
    version: AGENT_GENERATION_REVIEW_VERSION,
    name: AGENT_GENERATION_REVIEW_NAME,
    checksum: migrationChecksum(
      AGENT_GENERATION_REVIEW_VERSION,
      AGENT_GENERATION_REVIEW_NAME,
      "2026-07-18.1",
    ),
    up: upAgentGenerationReview,
    down: downAgentGenerationReview,
  },
  {
    version: CANVAS_ASSET_VERSION,
    name: CANVAS_ASSET_NAME,
    checksum: migrationChecksum(
      CANVAS_ASSET_VERSION,
      CANVAS_ASSET_NAME,
      "2026-07-18.1",
    ),
    up: upCanvasAsset,
    down: downCanvasAsset,
  },
  {
    version: USER_OAUTH_IDENTITY_VERSION,
    name: USER_OAUTH_IDENTITY_NAME,
    checksum: migrationChecksum(
      USER_OAUTH_IDENTITY_VERSION,
      USER_OAUTH_IDENTITY_NAME,
      "2026-07-18.1",
    ),
    up: upUserOauthIdentity,
    down: downUserOauthIdentity,
  },
  {
    version: MODEL_ROUTE_DISPLAY_NAME_VERSION,
    name: MODEL_ROUTE_DISPLAY_NAME_NAME,
    checksum: migrationChecksum(
      MODEL_ROUTE_DISPLAY_NAME_VERSION,
      MODEL_ROUTE_DISPLAY_NAME_NAME,
      "2026-07-19.1",
    ),
    up: upModelRouteDisplayName,
    down: downModelRouteDisplayName,
  },
  {
    version: VIDEO_FULFILLMENT_RECIPE_VERSION,
    name: VIDEO_FULFILLMENT_RECIPE_NAME,
    checksum: migrationChecksum(
      VIDEO_FULFILLMENT_RECIPE_VERSION,
      VIDEO_FULFILLMENT_RECIPE_NAME,
      "2026-07-19.1",
    ),
    up: upVideoFulfillmentRecipe,
    down: downVideoFulfillmentRecipe,
  },
  {
    version: USER_VIDEO_ENHANCE_TASK_VERSION,
    name: USER_VIDEO_ENHANCE_TASK_NAME,
    checksum: migrationChecksum(
      USER_VIDEO_ENHANCE_TASK_VERSION,
      USER_VIDEO_ENHANCE_TASK_NAME,
      "2026-07-19.1",
    ),
    up: upUserVideoEnhanceTask,
    down: downUserVideoEnhanceTask,
  },
  {
    version: RELEASE_DEPLOYMENT_ORCHESTRATION_VERSION,
    name: RELEASE_DEPLOYMENT_ORCHESTRATION_NAME,
    checksum: migrationChecksum(
      RELEASE_DEPLOYMENT_ORCHESTRATION_VERSION,
      RELEASE_DEPLOYMENT_ORCHESTRATION_NAME,
      "2026-07-19.3",
    ),
    up: upReleaseDeploymentOrchestration,
    down: downReleaseDeploymentOrchestration,
  },
  {
    version: RELEASE_DEPLOYMENT_RECONCILIATION_VERSION,
    name: RELEASE_DEPLOYMENT_RECONCILIATION_NAME,
    checksum: migrationChecksum(
      RELEASE_DEPLOYMENT_RECONCILIATION_VERSION,
      RELEASE_DEPLOYMENT_RECONCILIATION_NAME,
      "2026-07-19.1",
    ),
    up: upReleaseDeploymentReconciliation,
    down: downReleaseDeploymentReconciliation,
  },
  {
    version: DELETION_WORKFLOW_VERSION,
    name: DELETION_WORKFLOW_NAME,
    checksum: migrationChecksum(
      DELETION_WORKFLOW_VERSION,
      DELETION_WORKFLOW_NAME,
      DELETION_WORKFLOW_MIGRATION_IDENTITY.immutableRevision,
    ),
    requiredConstraints: [
      `table:${DELETION_OPERATION_TABLE}`,
      `table:${DELETION_RESOURCE_ALIAS_TABLE}`,
      "table:o_platform_release",
      "table:o_release_artifact",
    ],
    up: upDeletionWorkflow,
    down: downDeletionWorkflow,
  },
  {
    version: RELEASE_ARTIFACT_GENERATION_VERSION,
    name: RELEASE_ARTIFACT_GENERATION_NAME,
    checksum: migrationChecksum(
      RELEASE_ARTIFACT_GENERATION_VERSION,
      RELEASE_ARTIFACT_GENERATION_NAME,
      RELEASE_ARTIFACT_GENERATION_MIGRATION_IDENTITY.immutableRevision,
    ),
    requiredConstraints: [
      `table:${RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE}`,
      `column:${RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE}.releaseId`,
      `column:${RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE}.storageKey`,
      `index:${RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE}.${RELEASE_ARTIFACT_UPLOAD_RESERVATION_INDEXES.operatorIdempotency}`,
      `index:${RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE}.${RELEASE_ARTIFACT_UPLOAD_RESERVATION_INDEXES.storageKey}`,
      "column:o_release_artifact.uploadReservationId",
      "column:o_release_artifact.storageVersionId",
      "column:o_release_artifact.storageEtag",
      `index:o_release_artifact.${RELEASE_ARTIFACT_GENERATION_INDEXES.reservation}`,
    ],
    up: upReleaseArtifactGeneration,
    down: downReleaseArtifactGeneration,
  },
  {
    version: ACTIVE_PROJECT_TRIGGER_ROW_SHAPE_REPAIR_VERSION,
    name: ACTIVE_PROJECT_TRIGGER_ROW_SHAPE_REPAIR_NAME,
    checksum: migrationChecksum(
      ACTIVE_PROJECT_TRIGGER_ROW_SHAPE_REPAIR_VERSION,
      ACTIVE_PROJECT_TRIGGER_ROW_SHAPE_REPAIR_NAME,
      ACTIVE_PROJECT_TRIGGER_ROW_SHAPE_REPAIR_MIGRATION_IDENTITY
        .immutableRevision,
    ),
    requiredConstraints: [
      "column:o_media_asset.projectId",
      "column:o_media_asset.workspaceId",
      "column:o_user_video_enhance_task.projectId",
      "column:o_user_video_enhance_task.status",
      "column:o_user_video_enhance_task.workspaceId",
    ],
    up: upActiveProjectTriggerRowShapeRepair,
    down: downActiveProjectTriggerRowShapeRepair,
  },
  {
    version: IDENTITY_AUTHORITY_INTEGRITY_VERSION,
    name: IDENTITY_AUTHORITY_INTEGRITY_NAME,
    checksum: migrationChecksum(
      IDENTITY_AUTHORITY_INTEGRITY_VERSION,
      IDENTITY_AUTHORITY_INTEGRITY_NAME,
      IDENTITY_AUTHORITY_INTEGRITY_MIGRATION_IDENTITY.immutableRevision,
    ),
    requiredConstraints: IDENTITY_AUTHORITY_REQUIRED_CONSTRAINTS,
    up: upIdentityAuthorityIntegrity,
    down: downIdentityAuthorityIntegrity,
  },
  {
    version: SERVICE_REQUEST_V1_RUNTIME_VERSION,
    name: SERVICE_REQUEST_V1_RUNTIME_NAME,
    checksum: migrationChecksum(
      SERVICE_REQUEST_V1_RUNTIME_VERSION,
      SERVICE_REQUEST_V1_RUNTIME_NAME,
      SERVICE_REQUEST_V1_RUNTIME_MIGRATION_IDENTITY.immutableRevision,
    ),
    requiredConstraints: SERVICE_REQUEST_V1_REQUIRED_CONSTRAINTS,
    up: upServiceRequestV1Runtime,
    down: downServiceRequestV1Runtime,
  },
  {
    version: PROJECT_FOLDERS_VERSION,
    name: PROJECT_FOLDERS_NAME,
    checksum: migrationChecksum(
      PROJECT_FOLDERS_VERSION,
      PROJECT_FOLDERS_NAME,
      PROJECT_FOLDERS_MIGRATION_IDENTITY.immutableRevision,
    ),
    requiredConstraints: [`table:${PROJECT_FOLDER_TABLE}`],
    up: upProjectFolders,
    down: downProjectFolders,
  },
  {
    version: CANVAS_WORKFLOW_TEMPLATE_VERSION,
    name: CANVAS_WORKFLOW_TEMPLATE_NAME,
    checksum: migrationChecksum(
      CANVAS_WORKFLOW_TEMPLATE_VERSION,
      CANVAS_WORKFLOW_TEMPLATE_NAME,
      CANVAS_WORKFLOW_TEMPLATE_MIGRATION_IDENTITY.immutableRevision,
    ),
    requiredConstraints: CANVAS_WORKFLOW_TEMPLATE_REQUIRED_CONSTRAINTS,
    up: upCanvasWorkflowTemplate,
    down: downCanvasWorkflowTemplate,
  },
  {
    version: RELEASE_ARTIFACT_MULTIPART_UPLOAD_VERSION,
    name: RELEASE_ARTIFACT_MULTIPART_UPLOAD_NAME,
    checksum: migrationChecksum(
      RELEASE_ARTIFACT_MULTIPART_UPLOAD_VERSION,
      RELEASE_ARTIFACT_MULTIPART_UPLOAD_NAME,
      RELEASE_ARTIFACT_MULTIPART_UPLOAD_MIGRATION_IDENTITY.immutableRevision,
    ),
    requiredConstraints:
      RELEASE_ARTIFACT_MULTIPART_UPLOAD_REQUIRED_CONSTRAINTS,
    up: upReleaseArtifactMultipartUpload,
    down: downReleaseArtifactMultipartUpload,
  },
  {
    version: MODEL_ROUTE_CERTIFICATION_VERSION,
    name: MODEL_ROUTE_CERTIFICATION_NAME,
    checksum: migrationChecksum(
      MODEL_ROUTE_CERTIFICATION_VERSION,
      MODEL_ROUTE_CERTIFICATION_NAME,
      MODEL_ROUTE_CERTIFICATION_MIGRATION_IDENTITY.immutableRevision,
    ),
    requiredConstraints: MODEL_ROUTE_CERTIFICATION_REQUIRED_CONSTRAINTS,
    up: upModelRouteCertification,
    down: downModelRouteCertification,
  },
  {
    version: CACHE_STORAGE_ACCRUAL_VERSION,
    name: CACHE_STORAGE_ACCRUAL_NAME,
    checksum: migrationChecksum(
      CACHE_STORAGE_ACCRUAL_VERSION,
      CACHE_STORAGE_ACCRUAL_NAME,
      CACHE_STORAGE_ACCRUAL_MIGRATION_IDENTITY.immutableRevision,
    ),
    requiredConstraints: CACHE_STORAGE_ACCRUAL_REQUIRED_CONSTRAINTS,
    up: upCacheStorageAccrual,
    down: downCacheStorageAccrual,
  },
  {
    version: REFERENCE_MULTIPART_UPLOAD_VERSION,
    name: REFERENCE_MULTIPART_UPLOAD_NAME,
    checksum: migrationChecksum(
      REFERENCE_MULTIPART_UPLOAD_VERSION,
      REFERENCE_MULTIPART_UPLOAD_NAME,
      REFERENCE_MULTIPART_UPLOAD_MIGRATION_IDENTITY.immutableRevision,
    ),
    requiredConstraints: REFERENCE_MULTIPART_UPLOAD_REQUIRED_CONSTRAINTS,
    up: upReferenceMultipartUpload,
    down: downReferenceMultipartUpload,
  },
  {
    version: ONLINE_PAYMENT_ORDER_VERSION,
    name: ONLINE_PAYMENT_ORDER_NAME,
    checksum: migrationChecksum(
      ONLINE_PAYMENT_ORDER_VERSION,
      ONLINE_PAYMENT_ORDER_NAME,
      ONLINE_PAYMENT_ORDER_MIGRATION_IDENTITY.immutableRevision,
    ),
    requiredConstraints: ONLINE_PAYMENT_ORDER_REQUIRED_CONSTRAINTS,
    up: upOnlinePaymentOrder,
    down: downOnlinePaymentOrder,
  },
  {
    version: PORTRAIT_ASSET_ADMISSION_VERSION,
    name: PORTRAIT_ASSET_ADMISSION_NAME,
    checksum: migrationChecksum(
      PORTRAIT_ASSET_ADMISSION_VERSION,
      PORTRAIT_ASSET_ADMISSION_NAME,
      PORTRAIT_ASSET_ADMISSION_MIGRATION_IDENTITY.immutableRevision,
    ),
    requiredConstraints: PORTRAIT_ASSET_ADMISSION_V47_REQUIRED_CONSTRAINTS,
    up: upPortraitAssetAdmissionV47,
    down: downPortraitAssetAdmissionV47,
  },
  {
    version: PORTRAIT_ASSET_REVIEW_RUNTIME_VERSION,
    name: PORTRAIT_ASSET_REVIEW_RUNTIME_NAME,
    checksum: migrationChecksum(
      PORTRAIT_ASSET_REVIEW_RUNTIME_VERSION,
      PORTRAIT_ASSET_REVIEW_RUNTIME_NAME,
      PORTRAIT_ASSET_REVIEW_RUNTIME_MIGRATION_IDENTITY.immutableRevision,
    ),
    requiredConstraints: PORTRAIT_ASSET_REVIEW_RUNTIME_REQUIRED_CONSTRAINTS,
    up: upPortraitAssetReviewRuntime,
    down: downPortraitAssetReviewRuntime,
  },
  {
    version: ACCOUNT_WORKSPACE_ASSET_LIBRARY_VERSION,
    name: ACCOUNT_WORKSPACE_ASSET_LIBRARY_NAME,
    checksum: migrationChecksum(
      ACCOUNT_WORKSPACE_ASSET_LIBRARY_VERSION,
      ACCOUNT_WORKSPACE_ASSET_LIBRARY_NAME,
      ACCOUNT_WORKSPACE_ASSET_LIBRARY_MIGRATION_IDENTITY.immutableRevision,
    ),
    // 0.1.3 shipped these two additive migrations as one immutable v49 edge.
    // Keep the folded definition forever: production already records its
    // checksum and both constraint sets.
    requiredConstraints: [
      ...ACCOUNT_WORKSPACE_ASSET_LIBRARY_REQUIRED_CONSTRAINTS,
      ...PRICING_GROUP_REGISTRY_REQUIRED_CONSTRAINTS,
    ],
    up: async (trx) => {
      await upAccountWorkspaceAssetLibrary(trx);
      await upPricingGroupRegistry(trx);
    },
    down: downAccountWorkspaceAssetLibrary,
  },
  {
    version: PRICING_GROUP_REGISTRY_VERSION,
    name: PRICING_GROUP_REGISTRY_NAME,
    checksum: PRICING_GROUP_REGISTRY_CHECKSUM,
    // v49 already creates this schema in production. Re-running the idempotent
    // migration here preserves the v50 numbering used by 0.1.4/0.1.5 without
    // mutating the v49 ledger or requiring a production data rewrite.
    // The pricing-group constraints are facts of v49; re-declaring them here
    // would violate the migration allowlist's global uniqueness contract, so
    // v50 declares no additional required constraints. Release Controller
    // callers may cross it only through the exact immutable identity and
    // reviewed implementation checked above.
    requiredConstraints: [],
    up: upPricingGroupRegistry,
    down: downPricingGroupRegistry,
  },
  {
    version: MULTI_TENANT_DOMAIN_ALB_RELEASE_VERSION,
    name: MULTI_TENANT_DOMAIN_ALB_RELEASE_NAME,
    checksum: migrationChecksum(
      MULTI_TENANT_DOMAIN_ALB_RELEASE_VERSION,
      MULTI_TENANT_DOMAIN_ALB_RELEASE_NAME,
      MULTI_TENANT_DOMAIN_ALB_RELEASE_MIGRATION_IDENTITY.immutableRevision,
    ),
    requiredConstraints: MULTI_TENANT_DOMAIN_ALB_RELEASE_REQUIRED_CONSTRAINTS,
    up: upMultiTenantDomainAlbRelease,
    down: downMultiTenantDomainAlbRelease,
  },
  {
    version: FINANCIAL_DOMAIN_INTEGRITY_VERSION,
    name: FINANCIAL_DOMAIN_INTEGRITY_NAME,
    checksum: migrationChecksum(
      FINANCIAL_DOMAIN_INTEGRITY_VERSION,
      FINANCIAL_DOMAIN_INTEGRITY_NAME,
      FINANCIAL_DOMAIN_INTEGRITY_MIGRATION_IDENTITY.immutableRevision,
    ),
    requiredConstraints: FINANCIAL_DOMAIN_INTEGRITY_REQUIRED_CONSTRAINTS,
    up: upFinancialDomainIntegrity,
    down: downFinancialDomainIntegrity,
  },
  {
    version: MEDIA_SERVICES_MIGRATION_IDENTITY.version,
    name: MEDIA_SERVICES_MIGRATION_IDENTITY.name,
    checksum: migrationChecksum(MEDIA_SERVICES_MIGRATION_IDENTITY.version, MEDIA_SERVICES_MIGRATION_IDENTITY.name, MEDIA_SERVICES_MIGRATION_IDENTITY.immutableRevision),
    requiredConstraints: [`table:${MEDIA_SERVICE_TABLE}`],
    up: upMediaServices,
    down: downMediaServices,
  },
  {
    version: OBJECT_WRITE_ABSENCE_MIGRATION_IDENTITY.version,
    name: OBJECT_WRITE_ABSENCE_MIGRATION_IDENTITY.name,
    checksum: migrationChecksum(OBJECT_WRITE_ABSENCE_MIGRATION_IDENTITY.version, OBJECT_WRITE_ABSENCE_MIGRATION_IDENTITY.name, OBJECT_WRITE_ABSENCE_MIGRATION_IDENTITY.immutableRevision),
    requiredConstraints: [
      `table:${OBJECT_WRITE_ABSENCE_AUDIT_TABLE}`,
      `constraint:${OBJECT_WRITE_ABSENCE_AUDIT_TABLE}.chk_object_write_absence_audit_identity`,
      "constraint:o_object_write_intent.chk_o_object_write_intent_lifecycle",
    ],
    up: upObjectWriteAbsenceReconciliation,
    down: downObjectWriteAbsenceReconciliation,
  },
  {
    version: 55,
    name: "portrait_automatic_registration",
    checksum: migrationChecksum(55, "portrait_automatic_registration", "2026-09-09.1"),
    requiredConstraints: [
      "constraint:o_portrait_identity.chk_o_portrait_identity_state",
      "constraint:o_portrait_admission.chk_o_portrait_admission_state",
    ],
    up: upPortraitAutomaticRegistration,
    down: downPortraitAutomaticRegistration,
  },
  {
    version: 56,
    name: "membership_entitlements",
    checksum: migrationChecksum(56, "membership_entitlements", "2026-09-10.1"),
    requiredConstraints: [...MEMBERSHIP_REQUIRED_CONSTRAINTS],
    up: upMembershipEntitlements,
    down: downMembershipEntitlements,
  },
  {
    version: 57,
    name: "membership_resources",
    checksum: migrationChecksum(57, "membership_resources", "2026-09-10.1"),
    requiredConstraints: RESOURCE_CONSTRAINTS,
    up: upMembershipResources,
    down: downMembershipResources,
  },
  {
    version: 58,
    name: "asset_file_manager",
    checksum: migrationChecksum(58, "asset_file_manager", "2026-09-12.1"),
    requiredConstraints: FILE_MANAGER_CONSTRAINTS,
    up: upAssetFileManager,
    down: downAssetFileManager,
  },
  { version: 59, name: "external_tools", checksum: migrationChecksum(59, "external_tools", "2026-09-16.1"),
    requiredConstraints: ["table:o_external_tool_operation", "table:o_external_tool_upload"],
    up: upExternalTools, down: downExternalTools },
  {
    version: 60,
    name: "user_feedback",
    checksum: migrationChecksum(60, "user_feedback", "2026-09-16.1"),
    requiredConstraints: USER_FEEDBACK_REQUIRED_CONSTRAINTS,
    up: upUserFeedback,
    down: downUserFeedback,
  },
  { version: 61, name: "reference_document_upload", checksum: migrationChecksum(61, "reference_document_upload", "2026-11-01.1"),
    requiredConstraints: ["constraint:o_reference_multipart_upload.chk_o_reference_multipart_identity"],
    up: upReferenceDocumentUpload, down: downReferenceDocumentUpload },
] as const;

function normalizedMigrations(migrations: readonly DatabaseMigration[]): DatabaseMigration[] {
  const sorted = [...migrations].sort((left, right) => left.version - right.version);
  const versions = new Set<number>();
  const names = new Set<string>();
  for (const migration of sorted) {
    if (!Number.isSafeInteger(migration.version) || migration.version < 1) {
      throw new DatabaseMigrationError(`Invalid database migration version: ${migration.version}`);
    }
    if (!/^[a-z][a-z0-9_]*$/.test(migration.name)) {
      throw new DatabaseMigrationError(`Invalid database migration name: ${migration.name}`);
    }
    if (!/^[a-f0-9]{64}$/.test(migration.checksum)) {
      throw new DatabaseMigrationError(`Invalid checksum for database migration ${migration.version} (${migration.name}).`);
    }
    if (versions.has(migration.version)) {
      throw new DatabaseMigrationError(`Duplicate database migration version: ${migration.version}`);
    }
    if (names.has(migration.name)) {
      throw new DatabaseMigrationError(`Duplicate database migration name: ${migration.name}`);
    }
    versions.add(migration.version);
    names.add(migration.name);
  }
  for (const [index, migration] of sorted.entries()) {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new DatabaseMigrationError(
        `Database migration definitions must be contiguous from version 1; expected version ${expectedVersion}, received ${migration.version}.`,
      );
    }
  }
  return sorted;
}

const DEFAULT_MIGRATION_RUNNER_TIMEOUTS: MigrationRunnerTimeouts = {
  lockTimeoutMs: 60_000,
  lockPollIntervalMs: 250,
  statementTimeoutMs: 120_000,
  idleInTransactionTimeoutMs: 180_000,
  overallTimeoutMs: 600_000,
};

const systemMigrationClock: MigrationRunnerClock = {
  now: () => Date.now(),
  sleep: async (milliseconds) => {
    if (milliseconds <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  },
};

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

export function migrationRunnerTimeouts(
  env: EnvironmentLike = process.env,
  overrides: Partial<MigrationRunnerTimeouts> = {},
): MigrationRunnerTimeouts {
  const lockTimeoutMs = boundedInteger(
    overrides.lockTimeoutMs ?? env.FANJIN_MIGRATION_LOCK_TIMEOUT_MS,
    DEFAULT_MIGRATION_RUNNER_TIMEOUTS.lockTimeoutMs,
    100,
    300_000,
  );
  const overallTimeoutMs = boundedInteger(
    overrides.overallTimeoutMs ?? env.FANJIN_MIGRATION_OVERALL_TIMEOUT_MS,
    DEFAULT_MIGRATION_RUNNER_TIMEOUTS.overallTimeoutMs,
    1_000,
    3_600_000,
  );
  return {
    lockTimeoutMs,
    lockPollIntervalMs: Math.min(
      lockTimeoutMs,
      boundedInteger(
        overrides.lockPollIntervalMs ?? env.FANJIN_MIGRATION_LOCK_POLL_INTERVAL_MS,
        DEFAULT_MIGRATION_RUNNER_TIMEOUTS.lockPollIntervalMs,
        10,
        5_000,
      ),
    ),
    statementTimeoutMs: boundedInteger(
      overrides.statementTimeoutMs ?? env.FANJIN_MIGRATION_STATEMENT_TIMEOUT_MS,
      DEFAULT_MIGRATION_RUNNER_TIMEOUTS.statementTimeoutMs,
      1_000,
      900_000,
    ),
    idleInTransactionTimeoutMs: boundedInteger(
      overrides.idleInTransactionTimeoutMs
        ?? env.FANJIN_MIGRATION_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      DEFAULT_MIGRATION_RUNNER_TIMEOUTS.idleInTransactionTimeoutMs,
      1_000,
      900_000,
    ),
    overallTimeoutMs,
  };
}

function sqliteBusyTimeoutMs(): number {
  const parsed = Number(process.env.FANJIN_SQLITE_MIGRATION_BUSY_TIMEOUT_MS || 60_000);
  if (!Number.isFinite(parsed)) return 60_000;
  return Math.max(1_000, Math.min(300_000, Math.floor(parsed)));
}

function migrationChecksumChain(migrations: readonly DatabaseMigration[]): string {
  return crypto
    .createHash("sha256")
    .update(
      migrations
        .map(({ version, name, checksum }) => `${version}:${name}:${checksum}`)
        .join("\n"),
    )
    .digest("hex");
}

function safeEvidenceText(value: unknown, fallback: string, maximumLength: number): string {
  const normalized = String(value || "").trim();
  if (!normalized || /[\0\r\n]/.test(normalized)) return fallback;
  return normalized.slice(0, maximumLength);
}

function migrationSourceCommit(value: unknown): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(normalized)) return normalized;
  return "unattested-local";
}

function migrationRunId(value: unknown): string {
  const normalized = String(value || "").trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/.test(normalized)) return normalized;
  return crypto.randomUUID();
}

function hasValidSourceCommit(value: string): boolean {
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
}

function migrationOverallTimeoutError(): DatabaseMigrationError {
  return new DatabaseMigrationError(
    "Database migration exceeded the configured overall deadline.",
    DATABASE_MIGRATION_ERROR_CODES.OVERALL_TIMEOUT,
  );
}

function migrationAbortedError(): DatabaseMigrationError {
  return new DatabaseMigrationError(
    "Database migration was aborted before a proven completion boundary.",
    DATABASE_MIGRATION_ERROR_CODES.ABORTED,
  );
}

function assertBeforeDeadline(clock: MigrationRunnerClock, deadlineAt: number): void {
  if (clock.now() >= deadlineAt) throw migrationOverallTimeoutError();
}

function assertMigrationActive(
  clock: MigrationRunnerClock,
  deadlineAt: number,
  signal?: AbortSignal,
): void {
  if (signal?.aborted) throw migrationAbortedError();
  assertBeforeDeadline(clock, deadlineAt);
}

function postgresBoolean(result: unknown, column: string): boolean {
  const object = result && typeof result === "object"
    ? result as { rows?: Array<Record<string, unknown>> }
    : null;
  const value = object?.rows?.[0]?.[column];
  return value === true || value === 1 || value === "1" || value === "t";
}

export async function acquirePostgresMigrationLock(
  trx: Pick<Knex.Transaction, "raw">,
  options: {
    clock?: MigrationRunnerClock;
    lockTimeoutMs?: number;
    pollIntervalMs?: number;
    overallDeadlineAt?: number;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const clock = options.clock || systemMigrationClock;
  const lockTimeoutMs = boundedInteger(options.lockTimeoutMs, 60_000, 1, 300_000);
  const pollIntervalMs = boundedInteger(options.pollIntervalMs, 250, 1, 5_000);
  const deadlineAt = Math.min(
    clock.now() + lockTimeoutMs,
    options.overallDeadlineAt ?? Number.MAX_SAFE_INTEGER,
  );
  while (true) {
    if (options.signal?.aborted) throw migrationAbortedError();
    if (clock.now() >= deadlineAt) {
      throw new DatabaseMigrationError(
        "Timed out waiting for the PostgreSQL database migration lock.",
        DATABASE_MIGRATION_ERROR_CODES.LOCK_TIMEOUT,
      );
    }
    const result = await trx.raw(POSTGRES_MIGRATION_LOCK_SQL, [
      POSTGRES_MIGRATION_LOCK_KEY,
    ]);
    if (options.signal?.aborted) throw migrationAbortedError();
    if (postgresBoolean(result, "acquired")) return;
    const remaining = deadlineAt - clock.now();
    if (remaining <= 0) {
      throw new DatabaseMigrationError(
        "Timed out waiting for the PostgreSQL database migration lock.",
        DATABASE_MIGRATION_ERROR_CODES.LOCK_TIMEOUT,
      );
    }
    await clock.sleep(Math.min(pollIntervalMs, remaining));
  }
}

export async function configurePostgresMigrationTransaction(
  trx: Knex.Transaction,
  timeouts: MigrationRunnerTimeouts,
  remainingOverallMs: number,
): Promise<void> {
  const statementTimeoutMs = Math.max(
    1,
    Math.min(timeouts.statementTimeoutMs, Math.floor(remainingOverallMs)),
  );
  const lockTimeoutMs = Math.max(
    1,
    Math.min(timeouts.lockTimeoutMs, statementTimeoutMs),
  );
  const idleTimeoutMs = Math.max(
    1,
    Math.min(timeouts.idleInTransactionTimeoutMs, Math.floor(remainingOverallMs)),
  );
  await trx.raw("SELECT set_config('lock_timeout', ?, true)", [`${lockTimeoutMs}ms`]);
  await trx.raw("SELECT set_config('statement_timeout', ?, true)", [
    `${statementTimeoutMs}ms`,
  ]);
  await trx.raw(
    "SELECT set_config('idle_in_transaction_session_timeout', ?, true)",
    [`${idleTimeoutMs}ms`],
  );
}

function strictMigrationTimeoutMs(
  env: EnvironmentLike,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined) return defaultValue;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new DatabaseMigrationError(
      `${name} must be a canonical positive integer in milliseconds.`,
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new DatabaseMigrationError(
      `${name} must be between ${minimum} and ${maximum} milliseconds.`,
    );
  }
  return parsed;
}

export function postgresMigrationTimeoutsFromEnvironment(
  env: EnvironmentLike = process.env,
): PostgresMigrationTimeouts {
  return {
    lockTimeoutMs: strictMigrationTimeoutMs(
      env,
      "FANJIN_POSTGRES_MIGRATION_LOCK_TIMEOUT_MS",
      POSTGRES_MIGRATION_DEFAULT_LOCK_TIMEOUT_MS,
      100,
      POSTGRES_MIGRATION_MAX_LOCK_TIMEOUT_MS,
    ),
    statementTimeoutMs: strictMigrationTimeoutMs(
      env,
      "FANJIN_POSTGRES_MIGRATION_STATEMENT_TIMEOUT_MS",
      POSTGRES_MIGRATION_DEFAULT_STATEMENT_TIMEOUT_MS,
      1_000,
      POSTGRES_MIGRATION_MAX_STATEMENT_TIMEOUT_MS,
    ),
  };
}

export async function acquirePostgresMigrationTransactionLock(
  trx: Knex.Transaction,
  env: EnvironmentLike = process.env,
): Promise<PostgresMigrationTimeouts> {
  // The transaction-scoped advisory lock is deliberately first. Once this
  // process is the sole migrator, fail closed on configuration and install
  // bounded local timeouts before any catalog inspection or DDL.
  await trx.raw(POSTGRES_MIGRATION_TRANSACTION_LOCK_SQL, [
    POSTGRES_MIGRATION_LOCK_KEY,
  ]);
  const timeouts = postgresMigrationTimeoutsFromEnvironment(env);
  await trx.raw(
    `SET LOCAL lock_timeout = '${timeouts.lockTimeoutMs}ms'`,
  );
  await trx.raw(
    `SET LOCAL statement_timeout = '${timeouts.statementTimeoutMs}ms'`,
  );
  return timeouts;
}

async function ensureMigrationTable(client: Knex | Knex.Transaction): Promise<void> {
  if (await client.schema.hasTable(SCHEMA_MIGRATION_TABLE)) return;
  await client.schema.createTable(SCHEMA_MIGRATION_TABLE, (table) => {
    table.integer("version").notNullable().primary();
    table.text("name").notNullable().unique();
    table.text("checksum").notNullable();
    table.bigInteger("appliedAt").notNullable();
  });
}

async function ensureMigrationRunTable(client: Knex | Knex.Transaction): Promise<void> {
  if (!isPostgresClient(client)) {
    await client.raw(`PRAGMA busy_timeout = ${sqliteBusyTimeoutMs()}`);
  }
  await client.raw(
    `CREATE TABLE IF NOT EXISTS "${SCHEMA_MIGRATION_RUN_TABLE}" (
       "evidenceId" TEXT NOT NULL PRIMARY KEY,
       "runId" TEXT NOT NULL,
       "eventOrdinal" INTEGER NOT NULL,
       "sourceCommit" TEXT NOT NULL,
       "operatorIdentity" TEXT NOT NULL,
       "fromVersion" INTEGER NOT NULL,
       "toVersion" INTEGER NOT NULL,
       "checksumChain" TEXT NOT NULL,
       "startedAt" BIGINT NOT NULL,
       "finishedAt" BIGINT NULL,
       "durationMs" BIGINT NULL,
       "status" TEXT NOT NULL,
       "failedVersion" INTEGER NULL,
       "failureCode" TEXT NULL,
       "safeError" TEXT NULL,
       "backupCheckpointId" TEXT NULL,
       "beforeSchemaFingerprint" TEXT NULL,
       "afterSchemaFingerprint" TEXT NULL,
       UNIQUE ("runId", "eventOrdinal")
     )`,
  );
  await client.raw(
    `CREATE INDEX IF NOT EXISTS "${SCHEMA_MIGRATION_RUN_TABLE}_status_started_idx"
       ON "${SCHEMA_MIGRATION_RUN_TABLE}" ("status", "startedAt")`,
  );
  if (isPostgresClient(client)) {
    await client.raw(
      `CREATE OR REPLACE FUNCTION fanjin_reject_schema_migration_run_mutation()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $fanjin$
       BEGIN
         RAISE EXCEPTION 'schema migration run evidence is immutable'
           USING ERRCODE = '55000';
       END;
       $fanjin$`,
    );
    await client.raw(
      `DO $fanjin$
       BEGIN
         IF NOT EXISTS (
           SELECT 1
           FROM pg_catalog.pg_trigger trigger_row
           JOIN pg_catalog.pg_class table_row
             ON table_row.oid = trigger_row.tgrelid
           JOIN pg_catalog.pg_namespace namespace_row
             ON namespace_row.oid = table_row.relnamespace
           WHERE trigger_row.tgname = 'o_schema_migration_run_immutable'
             AND NOT trigger_row.tgisinternal
             AND table_row.relname = '${SCHEMA_MIGRATION_RUN_TABLE}'
             AND namespace_row.nspname = current_schema()
         ) THEN
           EXECUTE format(
             'CREATE TRIGGER o_schema_migration_run_immutable
                BEFORE UPDATE OR DELETE OR TRUNCATE ON %I.%I
                FOR EACH STATEMENT
                EXECUTE FUNCTION %I.fanjin_reject_schema_migration_run_mutation()',
             current_schema(),
             '${SCHEMA_MIGRATION_RUN_TABLE}',
             current_schema()
           );
         END IF;
       END;
       $fanjin$`,
    );
    return;
  }
  await client.raw(
    `CREATE TRIGGER IF NOT EXISTS "${SCHEMA_MIGRATION_RUN_TABLE}_immutable_update"
       BEFORE UPDATE ON "${SCHEMA_MIGRATION_RUN_TABLE}"
       BEGIN
         SELECT RAISE(ABORT, 'schema migration run evidence is immutable');
       END`,
  );
  await client.raw(
    `CREATE TRIGGER IF NOT EXISTS "${SCHEMA_MIGRATION_RUN_TABLE}_immutable_delete"
       BEFORE DELETE ON "${SCHEMA_MIGRATION_RUN_TABLE}"
       BEGIN
         SELECT RAISE(ABORT, 'schema migration run evidence is immutable');
       END`,
  );
}

async function ensureSqliteMigrationMetadata(client: Knex): Promise<void> {
  await client.raw(`PRAGMA busy_timeout = ${sqliteBusyTimeoutMs()}`);
  await client.raw(
    `CREATE TABLE IF NOT EXISTS "${SCHEMA_MIGRATION_TABLE}" (
       "version" INTEGER NOT NULL PRIMARY KEY,
       "name" TEXT NOT NULL UNIQUE,
       "checksum" TEXT NOT NULL,
       "appliedAt" BIGINT NOT NULL
     )`,
  );
  await client.raw(
    `CREATE TABLE IF NOT EXISTS "${SQLITE_MIGRATION_LOCK_TABLE}" (
       "id" INTEGER NOT NULL PRIMARY KEY,
       "touchedAt" BIGINT NOT NULL
     )`,
  );
  await client.raw(
    `INSERT OR IGNORE INTO "${SQLITE_MIGRATION_LOCK_TABLE}" ("id", "touchedAt") VALUES (1, 0)`,
  );
}

let sqliteMigrationQueue: Promise<void> = Promise.resolve();

async function serializeSqlite<T>(work: () => Promise<T>): Promise<T> {
  const previous = sqliteMigrationQueue;
  let release: () => void = () => undefined;
  sqliteMigrationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
  }
}

async function withMigrationLock<T>(
  client: Knex,
  options: {
    clock: MigrationRunnerClock;
    timeouts: MigrationRunnerTimeouts;
    overallDeadlineAt: number;
    signal?: AbortSignal;
  },
  work: (trx: Knex.Transaction) => Promise<T>,
): Promise<T> {
  if (isPostgresClient(client)) {
    return client.transaction(async (trx) => {
      assertMigrationActive(options.clock, options.overallDeadlineAt, options.signal);
      // The try-lock is transaction scoped: the same PostgreSQL connection
      // owns the lock and every DDL statement, while polling has a hard
      // deadline and a crash releases the lock.
      await acquirePostgresMigrationLock(trx, {
        clock: options.clock,
        lockTimeoutMs: options.timeouts.lockTimeoutMs,
        pollIntervalMs: options.timeouts.lockPollIntervalMs,
        overallDeadlineAt: options.overallDeadlineAt,
        signal: options.signal,
      });
      assertMigrationActive(options.clock, options.overallDeadlineAt, options.signal);
      await configurePostgresMigrationTransaction(
        trx,
        options.timeouts,
        options.overallDeadlineAt - options.clock.now(),
      );
      await ensureMigrationTable(trx);
      return work(trx);
    });
  }

  return serializeSqlite(async () => {
    // CREATE IF NOT EXISTS is safe before the first transaction. The lock-row
    // update is the first statement inside the transaction and obtains the
    // SQLite write lock before migration history is inspected.
    await ensureSqliteMigrationMetadata(client);
    return client.transaction(async (trx) => {
      assertMigrationActive(options.clock, options.overallDeadlineAt, options.signal);
      // busy_timeout must be applied to the actual transaction connection,
      // not only to an arbitrary pool connection.
      await trx.raw(`PRAGMA busy_timeout = ${sqliteBusyTimeoutMs()}`);
      await trx(SQLITE_MIGRATION_LOCK_TABLE)
        .where({ id: 1 })
        .update({ touchedAt: options.clock.now() });
      return work(trx);
    });
  });
}

async function readAppliedMigrations(client: Knex | Knex.Transaction): Promise<AppliedDatabaseMigration[]> {
  const rows = await client<AppliedDatabaseMigration>(SCHEMA_MIGRATION_TABLE)
    .select("version", "name", "checksum", "appliedAt")
    .orderBy("version", "asc");
  return rows.map((row) => ({
    version: Number(row.version),
    name: String(row.name),
    checksum: String(row.checksum),
    appliedAt: Number(row.appliedAt),
  }));
}

function validateAppliedHistory(
  applied: AppliedDatabaseMigration[],
  migrations: readonly DatabaseMigration[],
  options: DatabaseMigrationInspectionOptions = {},
): DatabaseMigrationStatus {
  const knownAppliedCount = Math.min(applied.length, migrations.length);
  for (let index = 0; index < knownAppliedCount; index += 1) {
    const row = applied[index];
    const expected = migrations[index];
    if (!expected || row.version !== expected.version) {
      throw new DatabaseMigrationError(
        `Database migration history is not a contiguous known prefix at version ${row.version}.`,
      );
    }
    if (row.name !== expected.name) {
      throw new DatabaseMigrationError(
        `Database migration ${row.version} name mismatch: database=${row.name}, application=${expected.name}.`,
      );
    }
    if (row.checksum !== expected.checksum) {
      throw new DatabaseMigrationError(
        `Database migration ${row.version} (${row.name}) checksum mismatch; released migrations are immutable.`,
      );
    }
  }

  const knownLatestVersion = migrations.at(-1)?.version || 0;
  const databaseVersion = applied.at(-1)?.version || 0;
  const compatibility = options.runtimeCompatibility?.schemaCompatibility;
  const runtimeBinaryVersion = options.runtimeCompatibility?.binarySchemaVersion;
  let runtimeCompatible = false;
  if (compatibility) {
    if (compatibility.binarySchemaVersion !== runtimeBinaryVersion) {
      throw new DatabaseMigrationError(
        "Runtime schema compatibility binary version does not match the release identity.",
      );
    }
    runtimeCompatible = compatibility.supportedDatabaseVersions.includes(databaseVersion);
  }

  if (applied.length > migrations.length) {
    const unknown = applied.slice(migrations.length);
    const edge = compatibility?.migration;
    const onlyApprovedNextExpand = unknown.length === 1
      && databaseVersion === knownLatestVersion + 1
      && edge !== null
      && edge !== undefined
      && edge.fromVersion === knownLatestVersion
      && edge.toVersion === databaseVersion
      && unknown[0].version === edge.toVersion
      && unknown[0].name === edge.migrationName
      && unknown[0].checksum === edge.migrationChecksum
      && isApprovedAdditiveSchemaWindow(edge);
    if (!runtimeCompatible || !onlyApprovedNextExpand) {
      throw new DatabaseMigrationError(
        `Database contains ${applied.length - migrations.length} unknown migration(s); refusing to continue with older application code.`,
      );
    }
  }

  if (compatibility?.migration) {
    const registered = migrations.find(
      (migration) => migration.version === compatibility.migration!.toVersion,
    );
    if (registered && (
      registered.name !== compatibility.migration.migrationName
      || registered.checksum !== compatibility.migration.migrationChecksum
      || !sameReleaseSchemaMigrationEdge(
        compatibility.migration,
        {
          ...compatibility.migration,
          migrationName: registered.name,
          migrationChecksum: registered.checksum,
        },
      )
    )) {
      runtimeCompatible = false;
    }
  }

  const pending = migrations
    .filter((migration) => migration.version > databaseVersion)
    .map(({ version, name, checksum }) => ({ version, name, checksum }));
  return {
    tableExists: true,
    current: pending.length === 0,
    applied,
    pending,
    latestVersion: Math.max(knownLatestVersion, databaseVersion),
    databaseVersion,
    knownLatestVersion,
    runtimeCompatible,
  };
}

async function inspectMigrationHistory(
  client: Knex | Knex.Transaction,
  migrations: readonly DatabaseMigration[],
  options: DatabaseMigrationInspectionOptions = {},
): Promise<DatabaseMigrationStatus> {
  const tableExists = await client.schema.hasTable(SCHEMA_MIGRATION_TABLE);
  if (!tableExists) {
    return {
      tableExists: false,
      current: migrations.length === 0,
      applied: [],
      pending: migrations.map(({ version, name, checksum }) => ({ version, name, checksum })),
      latestVersion: migrations.at(-1)?.version || 0,
      databaseVersion: 0,
      knownLatestVersion: migrations.at(-1)?.version || 0,
      runtimeCompatible: false,
    };
  }

  const columns = await tableColumns(client, SCHEMA_MIGRATION_TABLE);
  const missingColumns = ["version", "name", "checksum", "appliedAt"].filter((column) => !columns.includes(column));
  if (missingColumns.length) {
    throw new DatabaseMigrationError(
      `Database migration table is malformed; missing columns: ${missingColumns.join(", ")}.`,
    );
  }
  return validateAppliedHistory(await readAppliedMigrations(client), migrations, options);
}

export async function inspectDatabaseMigrations(
  client: Knex,
  migrationDefinitions: readonly DatabaseMigration[] = DATABASE_MIGRATIONS,
  options: InspectDatabaseMigrationOptions = {},
): Promise<DatabaseMigrationStatus> {
  const migrations = normalizedMigrations(migrationDefinitions);
  return inspectMigrationHistory(client, migrations, options);
}

function sameAppliedHistory(
  left: readonly AppliedDatabaseMigration[],
  right: readonly AppliedDatabaseMigration[],
): boolean {
  return left.length === right.length && left.every((row, index) => {
    const other = right[index];
    return row.version === other?.version
      && row.name === other.name
      && row.checksum === other.checksum;
  });
}

function requiredMigrationConstraints(value: readonly string[] | undefined): string[] {
  const constraints = [...(value || [])];
  if (
    // Schema 48 has more than 275 reviewed catalog facts across the immutable prefix,
    // and the cumulative 49/50/51 additive chain exceeds 512 facts. Bound
    // verification, but do not reject the reviewed production contract.
    constraints.length > 1280
    || new Set(constraints).size !== constraints.length
    || constraints.some((constraint) => !/^[a-z][A-Za-z0-9_.:-]{0,127}$/.test(constraint))
  ) {
    throw new DatabaseMigrationError(
      "Migration requiredConstraints contains an invalid or duplicate identifier.",
      DATABASE_MIGRATION_ERROR_CODES.SCHEMA_VERIFICATION_FAILED,
    );
  }
  return constraints.sort();
}

function normalizedMigrationFailure(error: unknown): DatabaseMigrationError {
  if (error instanceof DatabaseMigrationError) {
    const code = String(error.code || "");
    if ((Object.values(DATABASE_MIGRATION_ERROR_CODES) as string[]).includes(code)) {
      return new DatabaseMigrationError(migrationSafeError(code), code);
    }
    return new DatabaseMigrationError(
      "Database migration execution failed; inspect protected runtime logs for the original error.",
      DATABASE_MIGRATION_ERROR_CODES.EXECUTION_FAILED,
    );
  }
  const code = error && typeof error === "object"
    ? String((error as { code?: unknown }).code || "")
    : "";
  if (code === DATABASE_MIGRATION_ERROR_CODES.ABORTED) {
    return migrationAbortedError();
  }
  if (code === "57014") {
    return new DatabaseMigrationError(
      "A database migration statement exceeded its configured deadline.",
      DATABASE_MIGRATION_ERROR_CODES.STATEMENT_TIMEOUT,
    );
  }
  if (code === "55P03") {
    return new DatabaseMigrationError(
      "A database migration statement could not acquire its lock before the configured deadline.",
      DATABASE_MIGRATION_ERROR_CODES.LOCK_TIMEOUT,
    );
  }
  return new DatabaseMigrationError(
    "Database migration execution failed; inspect protected runtime logs for the original error.",
    DATABASE_MIGRATION_ERROR_CODES.EXECUTION_FAILED,
  );
}

function migrationSafeError(code: string): string {
  switch (code) {
    case DATABASE_MIGRATION_ERROR_CODES.ABORTED:
      return "Database migration was aborted before completion.";
    case DATABASE_MIGRATION_ERROR_CODES.BACKUP_CHECKPOINT_INVALID:
      return "Verified backup checkpoint metadata was invalid.";
    case DATABASE_MIGRATION_ERROR_CODES.BACKUP_CHECKPOINT_REQUIRED:
      return "A verified backup checkpoint is required before migration.";
    case DATABASE_MIGRATION_ERROR_CODES.EVIDENCE_PERSIST_FAILED:
      return "Durable migration evidence could not be persisted.";
    case DATABASE_MIGRATION_ERROR_CODES.HISTORY_CHANGED:
      return "Migration history changed after preflight and before execution.";
    case DATABASE_MIGRATION_ERROR_CODES.LOCK_TIMEOUT:
      return "Migration lock acquisition timed out.";
    case DATABASE_MIGRATION_ERROR_CODES.OVERALL_TIMEOUT:
      return "Migration runner exceeded its overall deadline.";
    case DATABASE_MIGRATION_ERROR_CODES.SCHEMA_VERIFICATION_FAILED:
      return "Schema fingerprint or critical constraint verification failed.";
    case DATABASE_MIGRATION_ERROR_CODES.SCHEMA_VERIFICATION_REQUIRED:
      return "Schema verification is required before migration.";
    case DATABASE_MIGRATION_ERROR_CODES.STATEMENT_TIMEOUT:
      return "A migration statement timed out.";
    default:
      return "Database migration execution failed.";
  }
}

async function appendMigrationRunEvidence(
  client: Knex | Knex.Transaction,
  evidence: DatabaseMigrationRunEvidence,
): Promise<void> {
  try {
    await client<DatabaseMigrationRunEvidence>(SCHEMA_MIGRATION_RUN_TABLE).insert(evidence);
  } catch {
    throw new DatabaseMigrationError(
      "Durable migration run evidence could not be appended.",
      DATABASE_MIGRATION_ERROR_CODES.EVIDENCE_PERSIST_FAILED,
    );
  }
}

async function readMigrationTerminalEvidence(
  client: Knex,
  runId: string,
): Promise<DatabaseMigrationRunEvidence | null> {
  const row = await client<DatabaseMigrationRunEvidence>(SCHEMA_MIGRATION_RUN_TABLE)
    .where({ runId, eventOrdinal: 1 })
    .first();
  return row || null;
}

function migrationEvidence(
  context: MigrationSafetyContext,
  input: {
    status: DatabaseMigrationRunEvidence["status"];
    eventOrdinal: 0 | 1;
    startedAt: number;
    finishedAt?: number | null;
    failedVersion?: number | null;
    failureCode?: string | null;
    safeError?: string | null;
    backupCheckpointId?: string | null;
    beforeSchemaFingerprint?: string | null;
    afterSchemaFingerprint?: string | null;
  },
): DatabaseMigrationRunEvidence {
  const finishedAt = input.finishedAt ?? null;
  return {
    evidenceId: `${context.runId}:${input.eventOrdinal}`,
    runId: context.runId,
    eventOrdinal: input.eventOrdinal,
    sourceCommit: context.sourceCommit,
    operatorIdentity: context.operatorIdentity,
    fromVersion: context.fromVersion,
    toVersion: context.toVersion,
    checksumChain: context.checksumChain,
    startedAt: input.startedAt,
    finishedAt,
    durationMs: finishedAt == null ? null : Math.max(0, finishedAt - input.startedAt),
    status: input.status,
    failedVersion: input.failedVersion ?? null,
    failureCode: input.failureCode ?? null,
    safeError: input.safeError ?? null,
    backupCheckpointId: input.backupCheckpointId ?? null,
    beforeSchemaFingerprint: input.beforeSchemaFingerprint ?? null,
    afterSchemaFingerprint: input.afterSchemaFingerprint ?? null,
  };
}

async function verifiedBackupCheckpoint(
  hooks: MigrationSafetyHooks | undefined,
  context: MigrationSafetyContext,
  required: boolean,
): Promise<VerifiedMigrationBackupCheckpoint | null> {
  const createCheckpoint = hooks?.createVerifiedBackupCheckpoint;
  if (!createCheckpoint) {
    if (!required) return null;
    throw new DatabaseMigrationError(
      "A verified backup checkpoint hook is required before applying database migrations.",
      DATABASE_MIGRATION_ERROR_CODES.BACKUP_CHECKPOINT_REQUIRED,
    );
  }
  let checkpoint: VerifiedMigrationBackupCheckpoint;
  try {
    checkpoint = await createCheckpoint(context);
  } catch (error) {
    if (
      error
      && typeof error === "object"
      && String((error as { code?: unknown }).code || "")
        === DATABASE_MIGRATION_ERROR_CODES.ABORTED
    ) {
      throw migrationAbortedError();
    }
    throw new DatabaseMigrationError(
      "The verified backup checkpoint hook failed.",
      DATABASE_MIGRATION_ERROR_CODES.BACKUP_CHECKPOINT_INVALID,
    );
  }
  if (
    !checkpoint
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{5,255}$/.test(String(checkpoint.checkpointId || ""))
    || checkpoint.sourceCommit !== context.sourceCommit
    || checkpoint.schemaVersion !== context.fromVersion
    || checkpoint.checksumChain !== context.appliedChecksumChain
    || !/^[a-f0-9]{64}$/.test(String(checkpoint.schemaFingerprint || ""))
    || !/^[a-f0-9]{64}$/.test(String(checkpoint.evidenceDigest || ""))
    || !Number.isSafeInteger(checkpoint.verifiedAt)
    || checkpoint.verifiedAt < 1
  ) {
    throw new DatabaseMigrationError(
      "Verified backup checkpoint metadata does not match the migration source and current schema.",
      DATABASE_MIGRATION_ERROR_CODES.BACKUP_CHECKPOINT_INVALID,
    );
  }
  return checkpoint;
}

function sameVerifiedBackupCheckpoint(
  left: VerifiedMigrationBackupCheckpoint | null,
  right: VerifiedMigrationBackupCheckpoint | null,
): boolean {
  return Boolean(
    left
    && right
    && left.checkpointId === right.checkpointId
    && left.sourceCommit === right.sourceCommit
    && left.schemaVersion === right.schemaVersion
    && left.checksumChain === right.checksumChain
    && left.schemaFingerprint === right.schemaFingerprint
    && left.evidenceDigest === right.evidenceDigest
    && left.verifiedAt === right.verifiedAt,
  );
}

async function verifiedSchemaFingerprint(
  client: Knex | Knex.Transaction,
  hooks: MigrationSafetyHooks | undefined,
  context: MigrationSafetyContext,
  input: {
    phase: "before" | "after";
    expectedVersion: number;
    requiredConstraints: readonly string[];
    required: boolean;
  },
): Promise<string | null> {
  const verifySchema = hooks?.verifySchema;
  if (!verifySchema) {
    if (!input.required) return null;
    throw new DatabaseMigrationError(
      "A schema fingerprint and critical constraint verification hook is required.",
      DATABASE_MIGRATION_ERROR_CODES.SCHEMA_VERIFICATION_REQUIRED,
    );
  }
  let result: MigrationSchemaVerification;
  try {
    result = await verifySchema(client, {
      ...context,
      phase: input.phase,
      expectedVersion: input.expectedVersion,
      requiredConstraints: input.requiredConstraints,
    });
  } catch (error) {
    if (
      error
      && typeof error === "object"
      && String((error as { code?: unknown }).code || "")
        === DATABASE_MIGRATION_ERROR_CODES.ABORTED
    ) {
      throw migrationAbortedError();
    }
    throw new DatabaseMigrationError(
      "Schema fingerprint and critical constraint verification failed.",
      DATABASE_MIGRATION_ERROR_CODES.SCHEMA_VERIFICATION_FAILED,
    );
  }
  const constraints = Array.isArray(result?.validatedConstraints)
    ? [...result.validatedConstraints]
    : [];
  if (
    !/^[a-f0-9]{64}$/.test(String(result?.fingerprint || ""))
    || constraints.some((constraint) => typeof constraint !== "string")
    || input.requiredConstraints.some((constraint) => !constraints.includes(constraint))
  ) {
    throw new DatabaseMigrationError(
      "Schema verification did not prove the expected fingerprint and critical constraints.",
      DATABASE_MIGRATION_ERROR_CODES.SCHEMA_VERIFICATION_FAILED,
    );
  }
  return result.fingerprint;
}

export async function runDatabaseMigrations(
  client: Knex,
  migrationDefinitions: readonly DatabaseMigration[] = DATABASE_MIGRATIONS,
  options: RunDatabaseMigrationOptions = {},
): Promise<DatabaseMigrationStatus> {
  const migrations = normalizedMigrations(migrationDefinitions);
  const clock = options.clock || systemMigrationClock;
  const timeouts = migrationRunnerTimeouts(process.env, options.timeouts);
  const sharedRequiredConstraints = requiredMigrationConstraints(options.requiredConstraints);
  const requiredConstraintsBefore = requiredMigrationConstraints(
    options.requiredConstraintsBefore ?? sharedRequiredConstraints,
  );
  const requiredConstraintsAfter = requiredMigrationConstraints(
    options.requiredConstraintsAfter ?? sharedRequiredConstraints,
  );
  const startedAt = clock.now();
  const overallDeadlineAt = startedAt + timeouts.overallTimeoutMs;
  const runId = migrationRunId(options.runId);
  const sourceCommit = migrationSourceCommit(
    options.sourceCommit
      || process.env.FANJIN_MIGRATION_SOURCE_COMMIT
      || process.env.GIT_COMMIT,
  );
  const operatorIdentity = safeEvidenceText(
    options.operatorIdentity || process.env.FANJIN_MIGRATION_OPERATOR,
    "local-process",
    128,
  );
  const productionSafetyRequired = options.requireSafetyHooks
    ?? ["prod", "production"].includes(
      String(process.env.NODE_ENV || "").trim().toLowerCase(),
    );

  const preliminary = await inspectMigrationHistory(client, migrations);
  const fromVersion = preliminary.applied.at(-1)?.version || 0;
  const context: MigrationSafetyContext = {
    runId,
    sourceCommit,
    operatorIdentity,
    fromVersion,
    toVersion: preliminary.latestVersion,
    appliedChecksumChain: migrationChecksumChain(migrations.slice(0, preliminary.applied.length)),
    checksumChain: migrationChecksumChain(migrations),
    pending: preliminary.pending,
  };

  let backupCheckpoint: VerifiedMigrationBackupCheckpoint | null = null;
  let beforeSchemaFingerprint: string | null = null;
  let afterSchemaFingerprint: string | null = null;
  let failedVersion: number | null = null;
  let evidenceStarted = false;
  let transactionCallbackStarted = false;
  let transactionWorkCompleted = false;

  try {
    assertMigrationActive(clock, overallDeadlineAt, options.signal);
    const pendingChanges = preliminary.pending.length > 0;
    const safetyRequired = productionSafetyRequired && pendingChanges;
    if (safetyRequired && !hasValidSourceCommit(context.sourceCommit)) {
      throw new DatabaseMigrationError(
        "An attested source commit is required before applying database migrations.",
        DATABASE_MIGRATION_ERROR_CODES.BACKUP_CHECKPOINT_INVALID,
      );
    }
    if (pendingChanges) {
      backupCheckpoint = await verifiedBackupCheckpoint(
        options.hooks,
        context,
        safetyRequired,
      );
    }
    // Production safety evidence is deliberately obtained before creating the
    // append-only run ledger or writing a started event. A missing, stale, or
    // mismatched checkpoint/schema proof therefore leaves the database
    // untouched. Both proofs are repeated under the migration lock below to
    // close the preflight-to-execution race.
    if (pendingChanges) {
      beforeSchemaFingerprint = await verifiedSchemaFingerprint(
        client,
        options.hooks,
        context,
        {
          phase: "before",
          expectedVersion: context.fromVersion,
          requiredConstraints: requiredConstraintsBefore,
          required: safetyRequired,
        },
      );
      if (
        safetyRequired
        && beforeSchemaFingerprint !== backupCheckpoint?.schemaFingerprint
      ) {
        throw new DatabaseMigrationError(
          "Schema fingerprint does not match the verified backup checkpoint.",
          DATABASE_MIGRATION_ERROR_CODES.SCHEMA_VERIFICATION_FAILED,
        );
      }
    }
    assertMigrationActive(clock, overallDeadlineAt, options.signal);

    return await withMigrationLock(
      client,
      { clock, timeouts, overallDeadlineAt, signal: options.signal },
      async (trx) => {
        transactionCallbackStarted = true;
        assertMigrationActive(clock, overallDeadlineAt, options.signal);
        const before = await inspectMigrationHistory(trx, migrations);
        if (!sameAppliedHistory(preliminary.applied, before.applied)) {
          if (!safetyRequired && before.current) {
            afterSchemaFingerprint = await verifiedSchemaFingerprint(
              trx,
              options.hooks,
              context,
              {
                phase: "after",
                expectedVersion: context.toVersion,
                requiredConstraints: requiredConstraintsAfter,
                required: false,
              },
            );
            await appendMigrationRunEvidence(
              trx,
              migrationEvidence(context, {
                status: "succeeded",
                eventOrdinal: 1,
                startedAt,
                finishedAt: clock.now(),
                afterSchemaFingerprint,
              }),
            );
            transactionWorkCompleted = true;
            return before;
          }
          throw new DatabaseMigrationError(
            "Database migration history changed after backup preflight; retry with a new checkpoint.",
            DATABASE_MIGRATION_ERROR_CODES.HISTORY_CHANGED,
          );
        }
        const lockedCheckpoint = safetyRequired && before.pending.length > 0
          ? await verifiedBackupCheckpoint(
            options.hooks,
            context,
            safetyRequired,
          )
          : null;
        if (
          safetyRequired
          && before.pending.length > 0
          && !sameVerifiedBackupCheckpoint(backupCheckpoint, lockedCheckpoint)
        ) {
          throw new DatabaseMigrationError(
            "Verified backup checkpoint changed after preflight.",
            DATABASE_MIGRATION_ERROR_CODES.BACKUP_CHECKPOINT_INVALID,
          );
        }
        const lockedBeforeSchemaFingerprint = await verifiedSchemaFingerprint(
          trx,
          options.hooks,
          context,
          {
            phase: "before",
            expectedVersion: context.fromVersion,
            requiredConstraints: requiredConstraintsBefore,
            required: safetyRequired,
          },
        );
        if (
          safetyRequired
          && (
            beforeSchemaFingerprint !== lockedBeforeSchemaFingerprint
            || lockedBeforeSchemaFingerprint !== backupCheckpoint?.schemaFingerprint
          )
        ) {
          throw new DatabaseMigrationError(
            "Schema fingerprint changed after backup preflight or differs from the backup checkpoint.",
            DATABASE_MIGRATION_ERROR_CODES.SCHEMA_VERIFICATION_FAILED,
          );
        }
        beforeSchemaFingerprint = lockedBeforeSchemaFingerprint;
        assertMigrationActive(clock, overallDeadlineAt, options.signal);

        await ensureMigrationRunTable(trx);
        await appendMigrationRunEvidence(
          trx,
          migrationEvidence(context, {
            status: "started",
            eventOrdinal: 0,
            startedAt,
          }),
        );
        evidenceStarted = true;

        for (const pending of before.pending) {
          assertMigrationActive(clock, overallDeadlineAt, options.signal);
          if (isPostgresClient(client)) {
            await configurePostgresMigrationTransaction(
              trx,
              timeouts,
              overallDeadlineAt - clock.now(),
            );
          }
          const migration = migrations.find(
            (candidate) => candidate.version === pending.version,
          );
          if (!migration) {
            throw new DatabaseMigrationError(
              `Missing migration implementation for version ${pending.version}.`,
            );
          }
          failedVersion = migration.version;
          await migration.up(trx);
          assertMigrationActive(clock, overallDeadlineAt, options.signal);
          await trx<AppliedDatabaseMigration>(SCHEMA_MIGRATION_TABLE).insert({
            version: migration.version,
            name: migration.name,
            checksum: migration.checksum,
            appliedAt: clock.now(),
          });
          failedVersion = null;
        }

        assertMigrationActive(clock, overallDeadlineAt, options.signal);
        const after = await inspectMigrationHistory(trx, migrations);
        if (!after.current) {
          throw new DatabaseMigrationError(
            "Database migration runner stopped before reaching the target version.",
          );
        }
        afterSchemaFingerprint = await verifiedSchemaFingerprint(
          trx,
          options.hooks,
          context,
          {
            phase: "after",
            expectedVersion: context.toVersion,
            requiredConstraints: requiredConstraintsAfter,
            required: safetyRequired,
          },
        );
        assertMigrationActive(clock, overallDeadlineAt, options.signal);
        await appendMigrationRunEvidence(
          trx,
          migrationEvidence(context, {
            status: "succeeded",
            eventOrdinal: 1,
            startedAt,
            finishedAt: clock.now(),
            backupCheckpointId: backupCheckpoint?.checkpointId,
            beforeSchemaFingerprint,
            afterSchemaFingerprint,
          }),
        );
        transactionWorkCompleted = true;
        return after;
      },
    );
  } catch (error) {
    const failure = normalizedMigrationFailure(error);
    if (!evidenceStarted) throw failure;
    let observed: DatabaseMigrationStatus;
    try {
      observed = await inspectDatabaseMigrations(client, migrations);
    } catch {
      throw new DatabaseMigrationError(
        "Migration transaction outcome could not be proven from durable history.",
        DATABASE_MIGRATION_ERROR_CODES.OUTCOME_UNKNOWN,
      );
    }

    if (transactionWorkCompleted && observed.current) {
      const terminal = await client.schema.hasTable(SCHEMA_MIGRATION_RUN_TABLE)
        ? await readMigrationTerminalEvidence(client, runId)
        : null;
      if (terminal?.status === "succeeded") return observed;
    }

    if (!transactionCallbackStarted || sameAppliedHistory(preliminary.applied, observed.applied)) {
      const durableStarted = await client.schema.hasTable(SCHEMA_MIGRATION_RUN_TABLE)
        ? await readMigrationTerminalEvidence(client, runId)
        : null;
      if (!durableStarted) {
        await ensureMigrationRunTable(client);
        await appendMigrationRunEvidence(
          client,
          migrationEvidence(context, {
            status: "started",
            eventOrdinal: 0,
            startedAt,
          }),
        );
      }
      await appendMigrationRunEvidence(
        client,
        migrationEvidence(context, {
          status: "failed",
          eventOrdinal: 1,
          startedAt,
          finishedAt: clock.now(),
          failedVersion,
          failureCode: failure.code,
          safeError: migrationSafeError(failure.code),
          backupCheckpointId: backupCheckpoint?.checkpointId,
          beforeSchemaFingerprint,
          afterSchemaFingerprint,
        }),
      );
      throw failure;
    }

    throw new DatabaseMigrationError(
      "Migration transaction outcome is ambiguous; do not retry until ledger and evidence are reconciled.",
      DATABASE_MIGRATION_ERROR_CODES.OUTCOME_UNKNOWN,
    );
  }
}

export async function rollbackDatabaseMigrations(
  client: Knex,
  options: RollbackDatabaseMigrationOptions = {},
): Promise<DatabaseMigrationStatus> {
  const environment = options.environment ?? process.env;
  const nodeEnvironment = String(environment.NODE_ENV || "").trim().toLowerCase();
  const sharedEnvironment = environment.FANJIN_SHARED_ENVIRONMENT === "1"
    || ["prod", "production", "stage", "staging"].includes(nodeEnvironment);
  if (sharedEnvironment) {
    const explicitlyAllowed = options.allowSharedEnvironmentRollback
      ?? environment.FANJIN_MIGRATION_ALLOW_SHARED_DOWN === "1";
    if (!explicitlyAllowed) {
      throw new DatabaseMigrationError(
        "Down migrations are refused by default in shared environments; use fix-forward or an approved recovery workflow.",
        DATABASE_MIGRATION_ERROR_CODES.SHARED_ROLLBACK_REFUSED,
      );
    }
    const backupCheckpointId = String(
      options.verifiedBackupCheckpointId
        || environment.FANJIN_MIGRATION_BACKUP_CHECKPOINT_ID
        || "",
    ).trim();
    const restoreDrillId = String(
      options.restoreDrillId
        || environment.FANJIN_MIGRATION_RESTORE_DRILL_ID
        || "",
    ).trim();
    const validReference = (value: string) =>
      /^[A-Za-z0-9][A-Za-z0-9._:/-]{5,255}$/.test(value);
    if (!validReference(backupCheckpointId) || !validReference(restoreDrillId)) {
      throw new DatabaseMigrationError(
        "Shared-environment recovery requires a verified backup checkpoint and restore-drill reference.",
        DATABASE_MIGRATION_ERROR_CODES.RECOVERY_EVIDENCE_REQUIRED,
      );
    }
  }
  const steps = options.steps ?? 1;
  if (!Number.isSafeInteger(steps) || steps < 1) {
    throw new DatabaseMigrationError("Database rollback steps must be a positive integer.");
  }
  const migrations = normalizedMigrations(options.migrations || DATABASE_MIGRATIONS);
  const timeouts = migrationRunnerTimeouts();
  const overallDeadlineAt = systemMigrationClock.now() + timeouts.overallTimeoutMs;
  return withMigrationLock(client, {
    clock: systemMigrationClock,
    timeouts,
    overallDeadlineAt,
  }, async (trx) => {
    const before = await inspectMigrationHistory(trx, migrations);
    const rollbackRows = before.applied.slice(-steps).reverse();
    for (const row of rollbackRows) {
      const migration = migrations.find((candidate) => candidate.version === row.version);
      if (!migration?.down) {
        throw new DatabaseMigrationError(
          `Migration ${row.version} (${row.name}) has no down migration; rollback refused without changing data.`,
        );
      }
      await migration.down(trx);
      await trx(SCHEMA_MIGRATION_TABLE).where({ version: row.version }).delete();
    }
    return inspectMigrationHistory(trx, migrations);
  });
}

export async function assertDatabaseMigrationsCurrent(
  client: Knex,
  migrationDefinitions: readonly DatabaseMigration[] = DATABASE_MIGRATIONS,
  options: DatabaseMigrationInspectionOptions = {},
): Promise<DatabaseMigrationStatus> {
  const status = await inspectDatabaseMigrations(client, migrationDefinitions, options);
  if (options.runtimeCompatibility && !status.runtimeCompatible) {
    throw new DatabaseMigrationError(
      `Runtime binary schema ${options.runtimeCompatibility.binarySchemaVersion} does not declare support for database schema ${status.databaseVersion}.`,
    );
  }
  if (!status.current && !status.runtimeCompatible) {
    const pending = status.pending.map((migration) => `${migration.version}:${migration.name}`).join(", ");
    throw new DatabaseMigrationError(
      `Database has pending migrations (${pending}). Run \"npm run migrate:database\" before starting production services.`,
    );
  }
  return status;
}

export function runtimeSchemaCompatibilityFromEnvironment(
  env: EnvironmentLike,
): DatabaseRuntimeSchemaCompatibility | null {
  const configured = String(env.FANJIN_RELEASE_MANIFEST_FILE || "").trim();
  if (!configured) return null;
  if (!path.isAbsolute(configured)) {
    throw new DatabaseMigrationError(
      "FANJIN_RELEASE_MANIFEST_FILE must be an absolute immutable release path.",
    );
  }
  let parsed: unknown;
  try {
    const metadata = fs.lstatSync(configured);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1
      || metadata.size > 32 * 1024 * 1024) {
      throw new Error("manifest metadata invalid");
    }
    parsed = JSON.parse(fs.readFileSync(configured, "utf8")) as unknown;
  } catch {
    throw new DatabaseMigrationError(
      "Release manifest is unavailable or invalid; runtime schema compatibility cannot be proven.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DatabaseMigrationError("Release manifest must be a JSON object.");
  }
  const manifest = parsed as Record<string, unknown>;
  if (!Number.isSafeInteger(manifest.schemaVersion) || Number(manifest.schemaVersion) < 1) {
    throw new DatabaseMigrationError("Release manifest schemaVersion is invalid.");
  }
  const binarySchemaVersion = Number(manifest.schemaVersion);
  const environmentVersion = String(env.FANJIN_RELEASE_SCHEMA_VERSION || "").trim();
  if (environmentVersion && Number(environmentVersion) !== binarySchemaVersion) {
    throw new DatabaseMigrationError(
      "Release manifest schemaVersion does not match FANJIN_RELEASE_SCHEMA_VERSION.",
    );
  }
  let schemaCompatibility: ReleaseSchemaCompatibilityV1;
  try {
    schemaCompatibility = parseReleaseSchemaCompatibility(
      manifest.schemaCompatibility,
      binarySchemaVersion,
    );
  } catch (error) {
    throw new DatabaseMigrationError(
      `Release schema compatibility declaration is invalid: ${(error as Error).message}`,
    );
  }
  return { binarySchemaVersion, schemaCompatibility };
}

export function shouldAutoMigrateDatabase(env: EnvironmentLike = process.env): boolean {
  if (String(env.FANJIN_AUTO_MIGRATE || "").trim() === "1") return true;
  const nodeEnv = String(env.NODE_ENV || "").trim().toLowerCase();
  return nodeEnv === "dev" || nodeEnv === "development" || nodeEnv === "test";
}

export async function prepareDatabaseForApplication(
  client: Knex,
  env: EnvironmentLike = process.env,
  migrationDefinitions: readonly DatabaseMigration[] = DATABASE_MIGRATIONS,
  options: RunDatabaseMigrationOptions & InspectDatabaseMigrationOptions = {},
): Promise<DatabaseMigrationStatus> {
  const runtimeCompatibility = runtimeSchemaCompatibilityFromEnvironment(env);
  if (shouldAutoMigrateDatabase(env)) {
    const nodeEnv = String(env.NODE_ENV || "").trim().toLowerCase();
    await runDatabaseMigrations(client, migrationDefinitions, {
      ...options,
      requireSafetyHooks: options.requireSafetyHooks
        ?? (nodeEnv === "prod" || nodeEnv === "production"),
    });
  }
  return assertDatabaseMigrationsCurrent(client, migrationDefinitions, {
    ...options,
    runtimeCompatibility:
      options.runtimeCompatibility ?? runtimeCompatibility,
  });
}
