import crypto from "node:crypto";

/**
 * Single source of truth for the immutable v35 migration identity.
 * Never revise an applied identity in place; append a new migration instead.
 * Both the migration registry and compatibility allowlist consume the
 * checksum, so stale manifests fail closed.
 */
export const DELETION_WORKFLOW_MIGRATION_IDENTITY = Object.freeze({
  version: 35,
  name: "deletion_workflow",
  immutableRevision: "2026-07-24.6",
});

export function checksumForMigrationIdentity(identity: {
  version: number;
  name: string;
  immutableRevision: string;
}): string {
  return crypto.createHash("sha256")
    .update(`${identity.version}:${identity.name}:${identity.immutableRevision}`)
    .digest("hex");
}

export const DELETION_WORKFLOW_MIGRATION_CHECKSUM =
  checksumForMigrationIdentity(DELETION_WORKFLOW_MIGRATION_IDENTITY);

/**
 * Additive storage-generation identity used by the release artifact upload
 * reservation flow. Keeping this separate from the deletion migration avoids
 * rewriting the already reviewed v35 history.
 */
export const RELEASE_ARTIFACT_GENERATION_MIGRATION_IDENTITY = Object.freeze({
  version: 36,
  name: "release_artifact_generation",
  immutableRevision: "2026-07-24.2",
});

export const RELEASE_ARTIFACT_GENERATION_MIGRATION_CHECKSUM =
  checksumForMigrationIdentity(RELEASE_ARTIFACT_GENERATION_MIGRATION_IDENTITY);

/**
 * Forward-only PostgreSQL trigger repair for databases that already recorded
 * v35 before its row-shape defect was discovered. It is an additive,
 * binary-compatible edge: no table or column contract changes.
 */
export const ACTIVE_PROJECT_TRIGGER_ROW_SHAPE_REPAIR_MIGRATION_IDENTITY =
  Object.freeze({
    version: 37,
    name: "active_project_trigger_row_shape_repair",
    immutableRevision: "2026-07-25.1",
  });

export const ACTIVE_PROJECT_TRIGGER_ROW_SHAPE_REPAIR_MIGRATION_CHECKSUM =
  checksumForMigrationIdentity(
    ACTIVE_PROJECT_TRIGGER_ROW_SHAPE_REPAIR_MIGRATION_IDENTITY,
  );

/**
 * Forward-only identity and workspace-authority integrity boundary. This
 * fails closed on ambiguous principals, installs database-enforced user
 * identity uniqueness, repairs the PostgreSQL user sequence, and adds the
 * append-only owner-transfer command ledger.
 */
export const IDENTITY_AUTHORITY_INTEGRITY_MIGRATION_IDENTITY = Object.freeze({
  version: 38,
  name: "identity_authority_integrity",
  immutableRevision: "2026-07-25.6",
});

export const IDENTITY_AUTHORITY_INTEGRITY_MIGRATION_CHECKSUM =
  checksumForMigrationIdentity(
    IDENTITY_AUTHORITY_INTEGRITY_MIGRATION_IDENTITY,
  );

/**
 * Additive storage contract for canonical service-request.v1 submission,
 * review, finance execution, durable intent/outbox, and bound proof audit.
 * Legacy request rows remain readable but are deliberately not promoted to
 * native finance authority.
 */
export const SERVICE_REQUEST_V1_RUNTIME_MIGRATION_IDENTITY = Object.freeze({
  version: 39,
  name: "service_request_v1_runtime",
  immutableRevision: "2026-07-25.4",
});

export const SERVICE_REQUEST_V1_RUNTIME_MIGRATION_CHECKSUM =
  checksumForMigrationIdentity(
    SERVICE_REQUEST_V1_RUNTIME_MIGRATION_IDENTITY,
  );

/**
 * Additive workspace folder metadata. The table is new and legacy binaries do
 * not read or write it, so schema 39 binaries remain valid during the 39/40
 * rolling window.
 */
export const PROJECT_FOLDERS_MIGRATION_IDENTITY = Object.freeze({
  version: 40,
  name: "project_folders",
  immutableRevision: "2026-07-25.1",
});

export const PROJECT_FOLDERS_MIGRATION_CHECKSUM =
  checksumForMigrationIdentity(PROJECT_FOLDERS_MIGRATION_IDENTITY);

/**
 * Additive, user-owned Canvas workflow template storage. Schema 40 binaries
 * do not read the new table, so the 40/41 rolling window is binary-compatible.
 * The identity was reserved in 0.0.8 and is first registered by 0.0.9.
 */
export const CANVAS_WORKFLOW_TEMPLATE_MIGRATION_IDENTITY = Object.freeze({
  version: 41,
  name: "canvas_workflow_template",
  immutableRevision: "2026-07-29.1",
});

export const CANVAS_WORKFLOW_TEMPLATE_MIGRATION_CHECKSUM =
  checksumForMigrationIdentity(CANVAS_WORKFLOW_TEMPLATE_MIGRATION_IDENTITY);

/**
 * Additive server-owned multipart upload session storage. Schema 41 binaries
 * ignore this table, so they remain valid while schema 42 binaries introduce
 * resumable release artifact uploads during a rolling deployment.
 */
export const RELEASE_ARTIFACT_MULTIPART_UPLOAD_MIGRATION_IDENTITY =
  Object.freeze({
    version: 42,
    name: "release_artifact_multipart_upload",
    immutableRevision: "2026-08-05.1",
  });

export const RELEASE_ARTIFACT_MULTIPART_UPLOAD_MIGRATION_CHECKSUM =
  checksumForMigrationIdentity(
    RELEASE_ARTIFACT_MULTIPART_UPLOAD_MIGRATION_IDENTITY,
  );

/**
 * Additive, append-only model route certification evidence. Schema 42
 * binaries ignore this table, so the 42/43 rolling window is compatible.
 * Never revise this identity after a production database records it.
 */
export const MODEL_ROUTE_CERTIFICATION_MIGRATION_IDENTITY = Object.freeze({
  version: 43,
  name: "model_route_certification",
  immutableRevision: "2026-08-05.2",
});

export const MODEL_ROUTE_CERTIFICATION_MIGRATION_CHECKSUM =
  checksumForMigrationIdentity(MODEL_ROUTE_CERTIFICATION_MIGRATION_IDENTITY);

/**
 * Additive durable cache-storage accrual state. Schema 43 binaries ignore the
 * table, so the 43/44 rolling window is binary-compatible. The rows are
 * financial evidence; never revise this identity after it is applied.
 */
export const CACHE_STORAGE_ACCRUAL_MIGRATION_IDENTITY = Object.freeze({
  version: 44,
  name: "cache_storage_accrual",
  immutableRevision: "2026-08-05.1",
});

export const CACHE_STORAGE_ACCRUAL_MIGRATION_CHECKSUM =
  checksumForMigrationIdentity(CACHE_STORAGE_ACCRUAL_MIGRATION_IDENTITY);

/**
 * Additive, project-scoped reference multipart upload sessions. Schema 44
 * binaries ignore the table, so the 44/45 rolling window is compatible.
 * Never revise this identity after it is applied; append schema 46 instead.
 */
export const REFERENCE_MULTIPART_UPLOAD_MIGRATION_IDENTITY = Object.freeze({
  version: 45,
  name: "reference_multipart_upload",
  immutableRevision: "2026-08-05.1",
});

export const REFERENCE_MULTIPART_UPLOAD_MIGRATION_CHECKSUM =
  checksumForMigrationIdentity(REFERENCE_MULTIPART_UPLOAD_MIGRATION_IDENTITY);

/**
 * Durable online-payment orders and verified provider-event evidence. Schema
 * 45 binaries ignore these additive tables, so the 45/46 rolling window is
 * binary-compatible. Financial evidence makes this identity immutable.
 */
export const ONLINE_PAYMENT_ORDER_MIGRATION_IDENTITY = Object.freeze({
  version: 46,
  name: "online_payment_order",
  immutableRevision: "2026-08-06.1",
});

export const ONLINE_PAYMENT_ORDER_MIGRATION_CHECKSUM =
  checksumForMigrationIdentity(ONLINE_PAYMENT_ORDER_MIGRATION_IDENTITY);

/**
 * Additive portrait admission, consent and provider-asset binding storage.
 * Schema 46 binaries do not read these tables, so the 46/47 rolling window is
 * binary compatible. The consent rows are production evidence; this identity
 * must never be revised after it is recorded by a production database.
 */
export const PORTRAIT_ASSET_ADMISSION_MIGRATION_IDENTITY = Object.freeze({
  version: 47,
  name: "portrait_asset_admission",
  immutableRevision: "2026-08-07.2",
});

export const PORTRAIT_ASSET_ADMISSION_MIGRATION_CHECKSUM =
  checksumForMigrationIdentity(PORTRAIT_ASSET_ADMISSION_MIGRATION_IDENTITY);

/**
 * Additive review/runtime extension for the immutable schema-47 portrait
 * admission contract. Schema-47 binaries ignore the new columns and tables,
 * so 47/48 is an approved binary-compatible rolling and rollback window.
 */
export const PORTRAIT_ASSET_REVIEW_RUNTIME_MIGRATION_IDENTITY = Object.freeze({
  version: 48,
  name: "portrait_asset_review_runtime",
  immutableRevision: "2026-08-09.1",
});

export const PORTRAIT_ASSET_REVIEW_RUNTIME_MIGRATION_CHECKSUM =
  checksumForMigrationIdentity(
    PORTRAIT_ASSET_REVIEW_RUNTIME_MIGRATION_IDENTITY,
  );

/**
 * Immutable 0.1.3 production foundation. The deployed 48 -> 49 edge contains
 * both account/workspace asset authority and the governed pricing-group
 * registry. Production has recorded this exact identity; never split it back
 * into an earlier draft revision or rewrite the production ledger.
 *
 * Schema-48 binaries ignore the additive tables, so the 48/49 window remains
 * binary compatible while newer binaries stop treating project provenance as
 * ownership and replace free-text pricing groups with a governed registry.
 */
export const ACCOUNT_WORKSPACE_ASSET_LIBRARY_MIGRATION_IDENTITY = Object.freeze({
  version: 49,
  name: "account_workspace_asset_library",
  immutableRevision: "2026-08-18.1",
});

export const ACCOUNT_WORKSPACE_ASSET_LIBRARY_MIGRATION_CHECKSUM =
  checksumForMigrationIdentity(
    ACCOUNT_WORKSPACE_ASSET_LIBRARY_MIGRATION_IDENTITY,
  );

/**
 * Compatibility reconciliation edge retained for branches that numbered the
 * pricing registry separately before the 0.1.3 production fold. Schema 49
 * already contains the registry; this migration is deliberately idempotent and
 * records version 50 without changing the immutable version-49 ledger row.
 */
export const PRICING_GROUP_REGISTRY_MIGRATION_IDENTITY = Object.freeze({
  version: 50,
  name: "pricing_group_registry",
  immutableRevision: "2026-08-17.1",
});

export const PRICING_GROUP_REGISTRY_MIGRATION_CHECKSUM =
  checksumForMigrationIdentity(PRICING_GROUP_REGISTRY_MIGRATION_IDENTITY);

/**
 * Additive Fanjin 0.1.4 multi-tenant domain, certificate, ALB release, user
 * attribution, consumption settlement and publisher linkage storage. Schema-50
 * binaries ignore these tables and columns, so the 50/51 rolling window is
 * binary-compatible. Attribution, allocation and cost rows are operational
 * evidence; never revise this identity after a production database records it.
 */
export const MULTI_TENANT_DOMAIN_ALB_RELEASE_MIGRATION_IDENTITY = Object.freeze({
  version: 51,
  name: "multi_tenant_domain_alb_release",
  immutableRevision: "2026-08-19.1",
});

export const MULTI_TENANT_DOMAIN_ALB_RELEASE_MIGRATION_CHECKSUM =
  checksumForMigrationIdentity(MULTI_TENANT_DOMAIN_ALB_RELEASE_MIGRATION_IDENTITY);

/**
 * Fix-forward uniqueness for active tenant hostnames and canonical provider
 * cost facts. Schema-51 binaries already treat both keys as unique, so adding
 * database enforcement is compatible across the 51/52 rolling window.
 */
export const FINANCIAL_DOMAIN_INTEGRITY_MIGRATION_IDENTITY = Object.freeze({
  version: 52,
  name: "financial_domain_integrity",
  immutableRevision: "2026-08-19.1",
});

export const FINANCIAL_DOMAIN_INTEGRITY_MIGRATION_CHECKSUM =
  checksumForMigrationIdentity(FINANCIAL_DOMAIN_INTEGRITY_MIGRATION_IDENTITY);

/** Schema 59 only adds tool-owned tables/indexes; it does not change schema-58
 * queries, job payloads or billing tables. This exact edge is also shipped in
 * the schema-58 bridge binary before any online migration is authorized. */
export const EXTERNAL_TOOLS_MIGRATION_IDENTITY = Object.freeze({
  version: 59, name: "external_tools", immutableRevision: "2026-09-16.1",
});
export const EXTERNAL_TOOLS_MIGRATION_CHECKSUM =
  checksumForMigrationIdentity(EXTERNAL_TOOLS_MIGRATION_IDENTITY);

/** Schema 60 adds private feedback tables only. Schema-59 readers and writers
 * ignore them; old binaries retain the exact migration identity during rollback. */
export const USER_FEEDBACK_MIGRATION_IDENTITY = Object.freeze({
  version: 60, name: "user_feedback", immutableRevision: "2026-09-16.1",
});
export const USER_FEEDBACK_MIGRATION_CHECKSUM =
  checksumForMigrationIdentity(USER_FEEDBACK_MIGRATION_IDENTITY);

/** Widen reference upload media types; no columns or legacy media semantics change.
 * A schema-60 bridge binary must explicitly accept schema 61 before rollout. */
export const REFERENCE_DOCUMENT_UPLOAD_MIGRATION_IDENTITY = Object.freeze({
  version: 61, name: "reference_document_upload", immutableRevision: "2026-11-01.1",
});
export const REFERENCE_DOCUMENT_UPLOAD_MIGRATION_CHECKSUM =
  checksumForMigrationIdentity(REFERENCE_DOCUMENT_UPLOAD_MIGRATION_IDENTITY);
