import type { Knex } from "knex";

export const PORTRAIT_ADMISSION_TABLE = "o_portrait_admission";
export const PORTRAIT_IDENTITY_TABLE = "o_portrait_identity";
export const PORTRAIT_CONSENT_TABLE = "o_portrait_consent";
export const PORTRAIT_PROVIDER_GROUP_TABLE = "o_portrait_provider_group";
export const PORTRAIT_PROVIDER_ASSET_TABLE = "o_portrait_provider_asset";
export const PORTRAIT_AUTH_SESSION_TABLE = "o_portrait_auth_session";
export const PORTRAIT_MANUAL_REVIEW_TABLE = "o_portrait_manual_review";
export const PORTRAIT_IMAGEX_REVIEW_JOB_TABLE = "o_portrait_imagex_review_job";

export const PORTRAIT_ASSET_INDEXES = {
  admissionAssetVersion: "uq_o_portrait_admission_asset_version",
  admissionProjectState: "idx_o_portrait_admission_project_state",
  admissionSyncState: "idx_o_portrait_admission_sync_state",
  admissionSourceRecovery: "idx_o_portrait_admission_source_recovery",
  identityWorkspaceState: "idx_o_portrait_identity_workspace_state",
  consentAdmissionTime: "idx_o_portrait_consent_admission_time",
  groupIdentityChannel: "uq_o_portrait_group_identity_channel",
  groupProviderId: "uq_o_portrait_group_provider_id",
  groupDue: "idx_o_portrait_group_due",
  assetAdmissionGroup: "uq_o_portrait_asset_admission_group",
  assetProviderId: "uq_o_portrait_asset_provider_id",
  assetDue: "idx_o_portrait_asset_due",
  sessionNonce: "uq_o_portrait_auth_session_nonce",
  sessionDue: "idx_o_portrait_auth_session_due",
  manualReviewIdempotency: "uq_o_portrait_manual_review_idempotency",
  manualReviewActive: "uq_o_portrait_manual_review_active",
  manualReviewQueue: "idx_o_portrait_manual_review_queue",
  manualReviewAdmin: "idx_o_portrait_manual_review_admin",
  imageXReviewBinding: "uq_o_portrait_imagex_review_binding",
  imageXReviewQueue: "idx_o_portrait_imagex_review_queue",
  imageXReviewAdmission: "idx_o_portrait_imagex_review_admission",
  imageXReviewWorkspace: "idx_o_portrait_imagex_review_workspace",
} as const;

export const PORTRAIT_ASSET_ADMISSION_REQUIRED_CONSTRAINTS = [
  `table:${PORTRAIT_ADMISSION_TABLE}`,
  `table:${PORTRAIT_IDENTITY_TABLE}`,
  `table:${PORTRAIT_CONSENT_TABLE}`,
  `table:${PORTRAIT_PROVIDER_GROUP_TABLE}`,
  `table:${PORTRAIT_PROVIDER_ASSET_TABLE}`,
  `table:${PORTRAIT_AUTH_SESSION_TABLE}`,
  `table:${PORTRAIT_MANUAL_REVIEW_TABLE}`,
  `table:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}`,
  `primary-key:${PORTRAIT_ADMISSION_TABLE}.id`,
  `primary-key:${PORTRAIT_IDENTITY_TABLE}.id`,
  `primary-key:${PORTRAIT_CONSENT_TABLE}.id`,
  `primary-key:${PORTRAIT_PROVIDER_GROUP_TABLE}.id`,
  `primary-key:${PORTRAIT_PROVIDER_ASSET_TABLE}.id`,
  `primary-key:${PORTRAIT_AUTH_SESSION_TABLE}.id`,
  `primary-key:${PORTRAIT_MANUAL_REVIEW_TABLE}.id`,
  `primary-key:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}.id`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.workspaceId`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.projectId`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.assetId`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.assetVersionId`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.mediaType`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.faceScanState`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.faceScanCoverage`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.manualReviewState`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.subjectKind`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.declarationState`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.moderationState`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.complianceState`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.providerSyncState`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.sourceRecoveryState`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.sourceRecoveryAttempts`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.sourceRecoveryNextAttemptAt`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.revision`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.createdAt`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.updatedAt`,
  `not-null:${PORTRAIT_IDENTITY_TABLE}.workspaceId`,
  `not-null:${PORTRAIT_IDENTITY_TABLE}.ownerUserId`,
  `not-null:${PORTRAIT_IDENTITY_TABLE}.kind`,
  `not-null:${PORTRAIT_IDENTITY_TABLE}.label`,
  `not-null:${PORTRAIT_IDENTITY_TABLE}.state`,
  `not-null:${PORTRAIT_IDENTITY_TABLE}.revision`,
  `not-null:${PORTRAIT_IDENTITY_TABLE}.createdAt`,
  `not-null:${PORTRAIT_IDENTITY_TABLE}.updatedAt`,
  `not-null:${PORTRAIT_CONSENT_TABLE}.workspaceId`,
  `not-null:${PORTRAIT_CONSENT_TABLE}.admissionId`,
  `not-null:${PORTRAIT_CONSENT_TABLE}.actorUserId`,
  `not-null:${PORTRAIT_CONSENT_TABLE}.consentType`,
  `not-null:${PORTRAIT_CONSENT_TABLE}.termsVersion`,
  `not-null:${PORTRAIT_CONSENT_TABLE}.evidenceHash`,
  `not-null:${PORTRAIT_CONSENT_TABLE}.scopeJson`,
  `not-null:${PORTRAIT_CONSENT_TABLE}.status`,
  `not-null:${PORTRAIT_CONSENT_TABLE}.grantedAt`,
  `not-null:${PORTRAIT_CONSENT_TABLE}.createdAt`,
  `not-null:${PORTRAIT_PROVIDER_GROUP_TABLE}.workspaceId`,
  `not-null:${PORTRAIT_PROVIDER_GROUP_TABLE}.identityId`,
  `not-null:${PORTRAIT_PROVIDER_GROUP_TABLE}.channelId`,
  `not-null:${PORTRAIT_PROVIDER_GROUP_TABLE}.provider`,
  `not-null:${PORTRAIT_PROVIDER_GROUP_TABLE}.providerAccountFingerprint`,
  `not-null:${PORTRAIT_PROVIDER_GROUP_TABLE}.projectName`,
  `not-null:${PORTRAIT_PROVIDER_GROUP_TABLE}.groupType`,
  `not-null:${PORTRAIT_PROVIDER_GROUP_TABLE}.state`,
  `not-null:${PORTRAIT_PROVIDER_GROUP_TABLE}.idempotencyKey`,
  `not-null:${PORTRAIT_PROVIDER_GROUP_TABLE}.retryCount`,
  `not-null:${PORTRAIT_PROVIDER_GROUP_TABLE}.nextAttemptAt`,
  `not-null:${PORTRAIT_PROVIDER_GROUP_TABLE}.createdAt`,
  `not-null:${PORTRAIT_PROVIDER_GROUP_TABLE}.updatedAt`,
  `not-null:${PORTRAIT_PROVIDER_ASSET_TABLE}.workspaceId`,
  `not-null:${PORTRAIT_PROVIDER_ASSET_TABLE}.admissionId`,
  `not-null:${PORTRAIT_PROVIDER_ASSET_TABLE}.groupBindingId`,
  `not-null:${PORTRAIT_PROVIDER_ASSET_TABLE}.channelId`,
  `not-null:${PORTRAIT_PROVIDER_ASSET_TABLE}.state`,
  `not-null:${PORTRAIT_PROVIDER_ASSET_TABLE}.idempotencyKey`,
  `not-null:${PORTRAIT_PROVIDER_ASSET_TABLE}.sourceSha256`,
  `not-null:${PORTRAIT_PROVIDER_ASSET_TABLE}.retryCount`,
  `not-null:${PORTRAIT_PROVIDER_ASSET_TABLE}.nextAttemptAt`,
  `not-null:${PORTRAIT_PROVIDER_ASSET_TABLE}.createdAt`,
  `not-null:${PORTRAIT_PROVIDER_ASSET_TABLE}.updatedAt`,
  `not-null:${PORTRAIT_AUTH_SESSION_TABLE}.workspaceId`,
  `not-null:${PORTRAIT_AUTH_SESSION_TABLE}.admissionId`,
  `not-null:${PORTRAIT_AUTH_SESSION_TABLE}.identityId`,
  `not-null:${PORTRAIT_AUTH_SESSION_TABLE}.groupBindingId`,
  `not-null:${PORTRAIT_AUTH_SESSION_TABLE}.channelId`,
  `not-null:${PORTRAIT_AUTH_SESSION_TABLE}.state`,
  `not-null:${PORTRAIT_AUTH_SESSION_TABLE}.callbackNonceHash`,
  `not-null:${PORTRAIT_AUTH_SESSION_TABLE}.expiresAt`,
  `not-null:${PORTRAIT_AUTH_SESSION_TABLE}.createdAt`,
  `not-null:${PORTRAIT_AUTH_SESSION_TABLE}.updatedAt`,
  `not-null:${PORTRAIT_MANUAL_REVIEW_TABLE}.admissionId`,
  `not-null:${PORTRAIT_MANUAL_REVIEW_TABLE}.workspaceId`,
  `not-null:${PORTRAIT_MANUAL_REVIEW_TABLE}.projectId`,
  `not-null:${PORTRAIT_MANUAL_REVIEW_TABLE}.assetVersionId`,
  `not-null:${PORTRAIT_MANUAL_REVIEW_TABLE}.sourceSha256`,
  `not-null:${PORTRAIT_MANUAL_REVIEW_TABLE}.sampleEvidenceHash`,
  `not-null:${PORTRAIT_MANUAL_REVIEW_TABLE}.admissionRevisionAtCreate`,
  `not-null:${PORTRAIT_MANUAL_REVIEW_TABLE}.idempotencyKey`,
  `not-null:${PORTRAIT_MANUAL_REVIEW_TABLE}.state`,
  `not-null:${PORTRAIT_MANUAL_REVIEW_TABLE}.revision`,
  `not-null:${PORTRAIT_MANUAL_REVIEW_TABLE}.createdAt`,
  `not-null:${PORTRAIT_MANUAL_REVIEW_TABLE}.updatedAt`,
  `not-null:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}.admissionId`,
  `not-null:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}.workspaceId`,
  `not-null:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}.projectId`,
  `not-null:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}.assetVersionId`,
  `not-null:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}.sourceSha256`,
  `not-null:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}.channelId`,
  `not-null:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}.credentialGeneration`,
  `not-null:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}.dataId`,
  `not-null:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}.sourceUrlHash`,
  `not-null:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}.requestEvidenceHash`,
  `not-null:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}.state`,
  `not-null:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}.policyVersion`,
  `not-null:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}.revision`,
  `not-null:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}.createdAt`,
  `not-null:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}.updatedAt`,
  `column:${PORTRAIT_ADMISSION_TABLE}.assetVersionId`,
  `column:${PORTRAIT_ADMISSION_TABLE}.faceScanState`,
  `column:${PORTRAIT_ADMISSION_TABLE}.faceScanCoverage`,
  `column:${PORTRAIT_ADMISSION_TABLE}.manualReviewState`,
  `column:${PORTRAIT_ADMISSION_TABLE}.currentManualReviewId`,
  `column:${PORTRAIT_ADMISSION_TABLE}.manualReviewDecision`,
  `column:${PORTRAIT_ADMISSION_TABLE}.currentImageXReviewJobId`,
  `column:${PORTRAIT_ADMISSION_TABLE}.subjectKind`,
  `column:${PORTRAIT_ADMISSION_TABLE}.moderationState`,
  `column:${PORTRAIT_ADMISSION_TABLE}.complianceState`,
  `column:${PORTRAIT_ADMISSION_TABLE}.providerSyncState`,
  `column:${PORTRAIT_ADMISSION_TABLE}.sourceRecoveryObjectIdentityJson`,
  `column:${PORTRAIT_ADMISSION_TABLE}.sourceRecoveryFailureCode`,
  `column:${PORTRAIT_ADMISSION_TABLE}.sourceRecoveryFailureMessage`,
  `column:${PORTRAIT_PROVIDER_GROUP_TABLE}.groupType`,
  `column:${PORTRAIT_PROVIDER_GROUP_TABLE}.providerAccountFingerprint`,
  `column:${PORTRAIT_PROVIDER_ASSET_TABLE}.providerAssetId`,
  `column:${PORTRAIT_AUTH_SESSION_TABLE}.callbackNonceHash`,
  `index:${PORTRAIT_ADMISSION_TABLE}.${PORTRAIT_ASSET_INDEXES.admissionAssetVersion}`,
  `index:${PORTRAIT_ADMISSION_TABLE}.${PORTRAIT_ASSET_INDEXES.admissionProjectState}`,
  `index:${PORTRAIT_ADMISSION_TABLE}.${PORTRAIT_ASSET_INDEXES.admissionSyncState}`,
  `index:${PORTRAIT_ADMISSION_TABLE}.${PORTRAIT_ASSET_INDEXES.admissionSourceRecovery}`,
  `index:${PORTRAIT_IDENTITY_TABLE}.${PORTRAIT_ASSET_INDEXES.identityWorkspaceState}`,
  `index:${PORTRAIT_CONSENT_TABLE}.${PORTRAIT_ASSET_INDEXES.consentAdmissionTime}`,
  `index:${PORTRAIT_PROVIDER_GROUP_TABLE}.${PORTRAIT_ASSET_INDEXES.groupIdentityChannel}`,
  `index:${PORTRAIT_PROVIDER_GROUP_TABLE}.${PORTRAIT_ASSET_INDEXES.groupProviderId}`,
  `index:${PORTRAIT_PROVIDER_GROUP_TABLE}.${PORTRAIT_ASSET_INDEXES.groupDue}`,
  `index:${PORTRAIT_PROVIDER_ASSET_TABLE}.${PORTRAIT_ASSET_INDEXES.assetAdmissionGroup}`,
  `index:${PORTRAIT_PROVIDER_ASSET_TABLE}.${PORTRAIT_ASSET_INDEXES.assetProviderId}`,
  `index:${PORTRAIT_PROVIDER_ASSET_TABLE}.${PORTRAIT_ASSET_INDEXES.assetDue}`,
  `index:${PORTRAIT_AUTH_SESSION_TABLE}.${PORTRAIT_ASSET_INDEXES.sessionNonce}`,
  `index:${PORTRAIT_AUTH_SESSION_TABLE}.${PORTRAIT_ASSET_INDEXES.sessionDue}`,
  `index:${PORTRAIT_MANUAL_REVIEW_TABLE}.${PORTRAIT_ASSET_INDEXES.manualReviewIdempotency}`,
  `index:${PORTRAIT_MANUAL_REVIEW_TABLE}.${PORTRAIT_ASSET_INDEXES.manualReviewActive}`,
  `index:${PORTRAIT_MANUAL_REVIEW_TABLE}.${PORTRAIT_ASSET_INDEXES.manualReviewQueue}`,
  `index:${PORTRAIT_MANUAL_REVIEW_TABLE}.${PORTRAIT_ASSET_INDEXES.manualReviewAdmin}`,
  `index:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}.${PORTRAIT_ASSET_INDEXES.imageXReviewBinding}`,
  `index:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}.${PORTRAIT_ASSET_INDEXES.imageXReviewQueue}`,
  `index:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}.${PORTRAIT_ASSET_INDEXES.imageXReviewAdmission}`,
  `index:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}.${PORTRAIT_ASSET_INDEXES.imageXReviewWorkspace}`,
] as const;

function requiredForeignKey(
  table: Knex.CreateTableBuilder,
  column: string,
  targetTable: string,
  targetColumn: string,
  constraintName: string,
): void {
  table.foreign(column, constraintName)
    .references(targetColumn)
    .inTable(targetTable)
    .onUpdate("CASCADE")
    .onDelete("RESTRICT");
}

/**
 * Additive portrait admission and provider-binding storage.
 *
 * Fanjin's object storage and asset rows remain authoritative. Provider group
 * and asset ids are rebuildable bindings, while declarations and consent are
 * retained as first-party compliance evidence. This helper constructs the
 * schema-48 terminal shape directly for isolated tests; the immutable release
 * registry applies v47 and then the additive v48 delta instead.
 */
export async function upPortraitAssetAdmission(
  trx: Knex.Transaction,
): Promise<void> {
  const tables = [
    PORTRAIT_ADMISSION_TABLE,
    PORTRAIT_IDENTITY_TABLE,
    PORTRAIT_CONSENT_TABLE,
    PORTRAIT_PROVIDER_GROUP_TABLE,
    PORTRAIT_PROVIDER_ASSET_TABLE,
    PORTRAIT_AUTH_SESSION_TABLE,
    PORTRAIT_MANUAL_REVIEW_TABLE,
    PORTRAIT_IMAGEX_REVIEW_JOB_TABLE,
  ];
  const existing = await Promise.all(tables.map((table) => trx.schema.hasTable(table)));
  if (existing.every(Boolean)) return;
  if (existing.some(Boolean)) {
    throw new Error("Migration portrait_asset_admission found a partial schema-48 installation");
  }
  for (const parent of [
    "o_workspace",
    "o_project",
    "o_user",
    "o_assets",
    "o_image",
    "o_provider_channel",
  ]) {
    if (!(await trx.schema.hasTable(parent))) {
      throw new Error(`Migration portrait_asset_admission requires table ${parent}`);
    }
  }

  await trx.schema.createTable(PORTRAIT_IDENTITY_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("workspaceId").notNullable();
    table.bigInteger("ownerUserId").notNullable();
    table.text("kind").notNullable();
    table.text("label").notNullable();
    table.text("state").notNullable().defaultTo("pending");
    table.text("activeConsentId");
    table.bigInteger("revision").notNullable().defaultTo(1);
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();

    // workspaceId/ownerUserId are immutable evidence snapshots, deliberately
    // not legacy-table FKs. Schema-46 account cleanup must remain executable
    // after the additive 46/47 bridge without cascading compliance evidence.
    table.index(
      ["workspaceId", "state", "updatedAt"],
      PORTRAIT_ASSET_INDEXES.identityWorkspaceState,
    );
    table.check(
      '"kind" IN (\'real_person\', \'virtual_person\', \'detected_person\')'
        + ' AND "state" IN (\'pending\', \'authorizing\', \'active\','
        + ' \'expired\', \'revoked\', \'failed\')'
        + ' AND length(trim("label")) BETWEEN 1 AND 120'
        + ' AND "ownerUserId" > 0 AND "revision" >= 1',
      {},
      "chk_o_portrait_identity_state",
    );
  });

  await trx.schema.createTable(PORTRAIT_ADMISSION_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("workspaceId").notNullable();
    table.bigInteger("projectId").notNullable();
    table.bigInteger("assetId").notNullable();
    table.bigInteger("assetVersionId").notNullable();
    table.text("mediaType").notNullable();
    table.text("sourceSha256");
    table.text("sourceRecoveryState").notNullable().defaultTo("pending");
    table.integer("sourceRecoveryAttempts").notNullable().defaultTo(0);
    table.bigInteger("sourceRecoveryNextAttemptAt").notNullable().defaultTo(0);
    table.text("sourceRecoveryLeaseOwner");
    table.bigInteger("sourceRecoveryLeaseExpiresAt");
    table.text("sourceRecoveryObjectIdentityJson");
    table.text("sourceRecoveryFailureCode");
    table.text("sourceRecoveryFailureMessage");
    table.text("faceScanState").notNullable().defaultTo("queued");
    table.text("faceScanCoverage").notNullable().defaultTo("none");
    table.integer("faceCount");
    table.text("detectorName");
    table.text("detectorVersion");
    table.float("detectorConfidence");
    table.text("detectorEvidenceHash");
    table.text("detectorEvidenceJson").notNullable().defaultTo("{}");
    table.text("manualReviewState").notNullable().defaultTo("not_required");
    table.text("currentManualReviewId");
    table.text("manualReviewDecision");
    table.text("manualReviewEvidenceHash");
    table.text("manualReviewPolicyVersion");
    table.bigInteger("manualReviewedByUserId");
    table.bigInteger("manualReviewedAt");
    table.text("currentImageXReviewJobId");
    table.text("subjectKind").notNullable().defaultTo("pending");
    table.text("declarationState").notNullable().defaultTo("pending");
    table.text("declarationVersion");
    table.bigInteger("declaredByUserId");
    table.bigInteger("declaredAt");
    table.text("identityId");
    table.text("currentConsentId");
    table.text("moderationState").notNullable().defaultTo("pending");
    table.text("moderationEvidenceHash");
    table.text("moderationPolicyVersion");
    table.text("moderationReasonCode");
    table.bigInteger("moderationUpdatedAt");
    table.text("complianceState").notNullable().defaultTo("pending");
    table.text("providerSyncState").notNullable().defaultTo("not_needed");
    table.text("currentProviderAssetBindingId");
    table.text("preferredProviderChannelId");
    table.text("safeErrorCode");
    table.text("safeErrorMessage");
    table.bigInteger("revision").notNullable().defaultTo(1);
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();

    // Legacy source ids remain first-party evidence snapshots rather than
    // RESTRICT/CASCADE FKs. This lets the schema-46 deletion workflow remove
    // projects and source media while retaining the admission audit record.
    requiredForeignKey(table, "identityId", PORTRAIT_IDENTITY_TABLE, "id", "fk_o_portrait_admission_identity");
    table.unique(["assetVersionId"], PORTRAIT_ASSET_INDEXES.admissionAssetVersion);
    table.index(
      ["workspaceId", "projectId", "complianceState", "updatedAt"],
      PORTRAIT_ASSET_INDEXES.admissionProjectState,
    );
    table.index(
      ["providerSyncState", "updatedAt"],
      PORTRAIT_ASSET_INDEXES.admissionSyncState,
    );
    table.index(
      ["sourceRecoveryState", "sourceRecoveryNextAttemptAt", "sourceRecoveryLeaseExpiresAt"],
      PORTRAIT_ASSET_INDEXES.admissionSourceRecovery,
    );
    table.check(
      '"mediaType" IN (\'image\', \'video\')'
        + ' AND "faceScanState" IN (\'queued\', \'scanning\', \'no_face\','
        + ' \'single_face\', \'multiple_faces\', \'uncertain\', \'failed\')'
        + ' AND "faceScanCoverage" IN (\'none\', \'full_image\', \'sampled_video\', \'full_video_manual\')'
        + ' AND "manualReviewState" IN (\'not_required\', \'pending\', \'in_review\', \'completed\', \'superseded\')'
        + ' AND ("manualReviewDecision" IS NULL OR "manualReviewDecision" IN'
        + ' (\'no_face\', \'single_face\', \'multiple_faces\', \'uncertain\'))'
        + ' AND ("manualReviewEvidenceHash" IS NULL OR length("manualReviewEvidenceHash") = 64)'
        + ' AND (("manualReviewState" = \'completed\' AND "currentManualReviewId" IS NOT NULL'
        + ' AND "manualReviewDecision" IS NOT NULL AND "manualReviewEvidenceHash" IS NOT NULL'
        + ' AND "manualReviewPolicyVersion" IS NOT NULL AND "manualReviewedByUserId" > 0'
        + ' AND "manualReviewedAt" IS NOT NULL AND "faceScanCoverage" = \'full_video_manual\')'
        + ' OR ("manualReviewState" <> \'completed\' AND "manualReviewDecision" IS NULL'
        + ' AND "manualReviewEvidenceHash" IS NULL AND "manualReviewPolicyVersion" IS NULL'
        + ' AND "manualReviewedByUserId" IS NULL AND "manualReviewedAt" IS NULL))'
        + ' AND "subjectKind" IN (\'pending\', \'ordinary\', \'real_person\','
        + ' \'virtual_person\', \'trusted_output\', \'ambiguous\', \'multiple_faces\', \'detected_person\')'
        + ' AND "declarationState" IN (\'not_required\', \'pending\', \'confirmed\', \'revoked\')'
        + ' AND "moderationState" IN (\'pending\', \'checking\', \'allowed\', \'denied\', \'failed\')'
        + ' AND "complianceState" IN (\'pending\', \'not_required\', \'allowed\','
        + ' \'denied\', \'expired\', \'revoked\')'
        + ' AND "providerSyncState" IN (\'not_needed\', \'queued\', \'authorizing\','
        + ' \'creating_group\', \'processing\', \'active\', \'failed\', \'stale\')'
        + ' AND ("sourceSha256" IS NULL OR length("sourceSha256") = 64)'
        + ' AND "sourceRecoveryState" IN (\'pending\', \'hashing\', \'retry\', \'ready\', \'terminal\')'
        + ' AND (("sourceRecoveryState" = \'ready\' AND "sourceSha256" IS NOT NULL)'
        + ' OR ("sourceRecoveryState" <> \'ready\' AND "sourceSha256" IS NULL))'
        + ' AND "sourceRecoveryAttempts" >= 0 AND "sourceRecoveryNextAttemptAt" >= 0'
        + ' AND (("sourceRecoveryLeaseOwner" IS NULL AND "sourceRecoveryLeaseExpiresAt" IS NULL)'
        + ' OR (length(trim("sourceRecoveryLeaseOwner")) BETWEEN 1 AND 256'
        + ' AND "sourceRecoveryLeaseExpiresAt" IS NOT NULL))'
        + ' AND (("sourceRecoveryState" = \'hashing\' AND "sourceSha256" IS NULL'
        + ' AND "sourceRecoveryLeaseOwner" IS NOT NULL)'
        + ' OR ("sourceRecoveryState" <> \'hashing\' AND "sourceRecoveryLeaseOwner" IS NULL))'
        + ' AND (("sourceRecoveryState" = \'ready\' AND length("sourceSha256") = 64'
        + ' AND "sourceRecoveryObjectIdentityJson" IS NOT NULL'
        + ' AND "sourceRecoveryFailureCode" IS NULL AND "sourceRecoveryFailureMessage" IS NULL)'
        + ' OR "sourceRecoveryState" <> \'ready\')'
        + ' AND (("sourceRecoveryState" = \'terminal\' AND "sourceSha256" IS NULL'
        + ' AND "sourceRecoveryFailureCode" IS NOT NULL'
        + ' AND "sourceRecoveryFailureMessage" IS NOT NULL)'
        + ' OR "sourceRecoveryState" <> \'terminal\')'
        + ' AND ("faceCount" IS NULL OR "faceCount" >= 0)'
        + ' AND ("detectorConfidence" IS NULL OR ("detectorConfidence" >= 0 AND "detectorConfidence" <= 1))'
        + ' AND ("detectorEvidenceHash" IS NULL OR length("detectorEvidenceHash") = 64)'
        + ' AND ("moderationEvidenceHash" IS NULL OR length("moderationEvidenceHash") = 64)'
        + ' AND (("moderationState" IN (\'allowed\', \'denied\')'
        + ' AND "moderationEvidenceHash" IS NOT NULL AND "moderationUpdatedAt" IS NOT NULL)'
        + ' OR "moderationState" IN (\'pending\', \'checking\', \'failed\'))'
        + ' AND "revision" >= 1',
      {},
      "chk_o_portrait_admission_state",
    );
  });

  await trx.schema.createTable(PORTRAIT_CONSENT_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("workspaceId").notNullable();
    table.text("admissionId").notNullable();
    table.text("identityId");
    table.bigInteger("actorUserId").notNullable();
    table.text("consentType").notNullable();
    table.text("termsVersion").notNullable();
    table.text("evidenceHash").notNullable();
    table.text("scopeJson").notNullable();
    table.text("status").notNullable().defaultTo("active");
    table.bigInteger("grantedAt").notNullable();
    table.bigInteger("expiresAt");
    table.bigInteger("revokedAt");
    table.text("revokeReason");
    table.bigInteger("createdAt").notNullable();

    requiredForeignKey(table, "admissionId", PORTRAIT_ADMISSION_TABLE, "id", "fk_o_portrait_consent_admission");
    requiredForeignKey(table, "identityId", PORTRAIT_IDENTITY_TABLE, "id", "fk_o_portrait_consent_identity");
    table.index(
      ["admissionId", "grantedAt"],
      PORTRAIT_ASSET_INDEXES.consentAdmissionTime,
    );
    table.check(
      '"consentType" IN (\'real_person_rights\', \'virtual_person_rights\','
        + ' \'trusted_output_attestation\')'
        + ' AND "status" IN (\'active\', \'revoked\', \'expired\')'
        + ' AND length("evidenceHash") = 64'
        + ' AND length(trim("termsVersion")) BETWEEN 3 AND 128'
        + ' AND "actorUserId" > 0'
        + ' AND ("expiresAt" IS NULL OR "expiresAt" > "grantedAt")'
        + ' AND (("status" = \'revoked\' AND "revokedAt" IS NOT NULL'
        + ' AND "revokeReason" IS NOT NULL AND length(trim("revokeReason")) > 0)'
        + ' OR ("status" <> \'revoked\' AND "revokedAt" IS NULL'
        + ' AND "revokeReason" IS NULL))',
      {},
      "chk_o_portrait_consent_state",
    );
  });

  await trx.schema.createTable(PORTRAIT_PROVIDER_GROUP_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("workspaceId").notNullable();
    table.text("identityId").notNullable();
    table.text("channelId").notNullable();
    table.text("provider").notNullable();
    table.text("providerAccountFingerprint").notNullable();
    table.text("projectName").notNullable();
    table.text("groupType").notNullable();
    table.text("providerGroupId");
    table.text("state").notNullable().defaultTo("queued");
    table.text("idempotencyKey").notNullable();
    table.integer("retryCount").notNullable().defaultTo(0);
    table.bigInteger("nextAttemptAt").notNullable();
    table.text("leaseOwner");
    table.bigInteger("leaseExpiresAt");
    table.text("safeErrorCode");
    table.text("safeErrorMessage");
    table.bigInteger("activeAt");
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();

    requiredForeignKey(table, "identityId", PORTRAIT_IDENTITY_TABLE, "id", "fk_o_portrait_group_identity");
    table.unique(
      ["identityId", "channelId", "providerAccountFingerprint", "projectName", "groupType"],
      PORTRAIT_ASSET_INDEXES.groupIdentityChannel,
    );
    table.unique(
      ["channelId", "providerGroupId"],
      PORTRAIT_ASSET_INDEXES.groupProviderId,
    );
    table.index(
      ["state", "nextAttemptAt", "leaseExpiresAt"],
      PORTRAIT_ASSET_INDEXES.groupDue,
    );
    table.check(
      '"groupType" IN (\'AIGC\', \'LivenessFace\')'
        + ' AND "state" IN (\'queued\', \'authorizing\', \'creating\', \'active\','
        + ' \'failed\', \'stale\', \'revoked\')'
        + ' AND length("providerAccountFingerprint") = 64'
        + ' AND length(trim("projectName")) BETWEEN 1 AND 128'
        + ' AND length(trim("idempotencyKey")) BETWEEN 8 AND 255'
        + ' AND "retryCount" >= 0'
        + ' AND (("leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL)'
        + ' OR ("leaseOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL))'
        + ' AND (("state" = \'active\' AND "providerGroupId" IS NOT NULL'
        + ' AND length(trim("providerGroupId")) > 0 AND "activeAt" IS NOT NULL)'
        + ' OR "state" <> \'active\')',
      {},
      "chk_o_portrait_group_state",
    );
  });

  await trx.schema.createTable(PORTRAIT_PROVIDER_ASSET_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("workspaceId").notNullable();
    table.text("admissionId").notNullable();
    table.text("groupBindingId").notNullable();
    table.text("channelId").notNullable();
    table.text("providerAssetId");
    table.text("providerAssetUri");
    table.text("state").notNullable().defaultTo("queued");
    table.text("idempotencyKey").notNullable();
    table.text("sourceSha256").notNullable();
    table.integer("retryCount").notNullable().defaultTo(0);
    table.bigInteger("nextAttemptAt").notNullable();
    table.text("leaseOwner");
    table.bigInteger("leaseExpiresAt");
    table.text("safeErrorCode");
    table.text("safeErrorMessage");
    table.bigInteger("activeAt");
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();

    requiredForeignKey(table, "admissionId", PORTRAIT_ADMISSION_TABLE, "id", "fk_o_portrait_provider_asset_admission");
    requiredForeignKey(table, "groupBindingId", PORTRAIT_PROVIDER_GROUP_TABLE, "id", "fk_o_portrait_provider_asset_group");
    table.unique(
      ["admissionId", "groupBindingId"],
      PORTRAIT_ASSET_INDEXES.assetAdmissionGroup,
    );
    table.unique(
      ["channelId", "providerAssetId"],
      PORTRAIT_ASSET_INDEXES.assetProviderId,
    );
    table.index(
      ["state", "nextAttemptAt", "leaseExpiresAt"],
      PORTRAIT_ASSET_INDEXES.assetDue,
    );
    table.check(
      '"state" IN (\'queued\', \'submitting\', \'processing\', \'active\','
        + ' \'failed\', \'stale\', \'revoked\')'
        + ' AND length("sourceSha256") = 64'
        + ' AND length(trim("idempotencyKey")) BETWEEN 8 AND 255'
        + ' AND "retryCount" >= 0'
        + ' AND (("leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL)'
        + ' OR ("leaseOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL))'
        + ' AND (("state" = \'active\' AND "providerAssetId" IS NOT NULL'
        + ' AND length(trim("providerAssetId")) > 0'
        + ' AND "providerAssetUri" IS NOT NULL AND length(trim("providerAssetUri")) > 0'
        + ' AND "activeAt" IS NOT NULL)'
        + ' OR "state" <> \'active\')',
      {},
      "chk_o_portrait_provider_asset_state",
    );
  });

  await trx.schema.createTable(PORTRAIT_AUTH_SESSION_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("workspaceId").notNullable();
    table.text("admissionId").notNullable();
    table.text("identityId").notNullable();
    table.text("groupBindingId").notNullable();
    table.text("channelId").notNullable();
    table.text("state").notNullable().defaultTo("created");
    table.text("callbackNonceHash").notNullable();
    table.text("providerSessionId");
    table.text("bytedTokenDigest");
    table.bigInteger("expiresAt").notNullable();
    table.bigInteger("consumedAt");
    table.bigInteger("resultReceivedAt");
    table.text("safeErrorCode");
    table.text("safeErrorMessage");
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();

    requiredForeignKey(table, "admissionId", PORTRAIT_ADMISSION_TABLE, "id", "fk_o_portrait_auth_admission");
    requiredForeignKey(table, "identityId", PORTRAIT_IDENTITY_TABLE, "id", "fk_o_portrait_auth_identity");
    requiredForeignKey(table, "groupBindingId", PORTRAIT_PROVIDER_GROUP_TABLE, "id", "fk_o_portrait_auth_group");
    table.unique(["callbackNonceHash"], PORTRAIT_ASSET_INDEXES.sessionNonce);
    table.index(["state", "expiresAt"], PORTRAIT_ASSET_INDEXES.sessionDue);
    table.check(
      '"state" IN (\'created\', \'waiting_user\', \'verifying\', \'succeeded\','
        + ' \'failed\', \'expired\', \'cancelled\')'
        + ' AND length("callbackNonceHash") = 64'
        + ' AND ("bytedTokenDigest" IS NULL OR length("bytedTokenDigest") = 64)'
        + ' AND "expiresAt" > "createdAt"'
        + ' AND (("state" = \'succeeded\' AND "consumedAt" IS NOT NULL'
        + ' AND "resultReceivedAt" IS NOT NULL AND "bytedTokenDigest" IS NOT NULL)'
        + ' OR "state" <> \'succeeded\')',
      {},
      "chk_o_portrait_auth_session_state",
    );
  });

  await trx.schema.createTable(PORTRAIT_MANUAL_REVIEW_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("admissionId").notNullable();
    table.text("workspaceId").notNullable();
    table.bigInteger("projectId").notNullable();
    table.bigInteger("assetVersionId").notNullable();
    table.text("sourceSha256").notNullable();
    table.text("sampleEvidenceHash").notNullable();
    table.bigInteger("admissionRevisionAtCreate").notNullable();
    table.text("idempotencyKey").notNullable();
    table.text("state").notNullable().defaultTo("pending");
    table.bigInteger("claimOwnerUserId");
    table.text("claimSessionHash");
    table.bigInteger("claimLeaseExpiresAt");
    table.text("decision");
    table.text("policyVersion");
    table.text("attestationHash");
    table.bigInteger("reviewedAt");
    table.bigInteger("releasedAt");
    table.bigInteger("revision").notNullable().defaultTo(1);
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();

    requiredForeignKey(table, "admissionId", PORTRAIT_ADMISSION_TABLE, "id", "fk_o_portrait_manual_review_admission");
    // Immutable audit snapshot: no legacy o_user FK, preserving v47 binary rollback.
    table.unique(["idempotencyKey"], PORTRAIT_ASSET_INDEXES.manualReviewIdempotency);
    table.index(["state", "createdAt", "id"], PORTRAIT_ASSET_INDEXES.manualReviewQueue);
    table.index(
      ["claimOwnerUserId", "state", "claimLeaseExpiresAt"],
      PORTRAIT_ASSET_INDEXES.manualReviewAdmin,
    );
    table.check(
      '"state" IN (\'pending\', \'claimed\', \'completed\', \'released\', \'superseded\')'
        + ' AND length("sourceSha256") = 64 AND length("sampleEvidenceHash") = 64'
        + ' AND length(trim("idempotencyKey")) BETWEEN 16 AND 255'
        + ' AND "projectId" > 0 AND "assetVersionId" > 0'
        + ' AND "admissionRevisionAtCreate" >= 1 AND "revision" >= 1'
        + ' AND (("state" = \'claimed\' AND "claimOwnerUserId" > 0'
        + ' AND length("claimSessionHash") = 64 AND "claimLeaseExpiresAt" IS NOT NULL)'
        + ' OR ("state" <> \'claimed\' AND "claimOwnerUserId" IS NULL'
        + ' AND "claimSessionHash" IS NULL AND "claimLeaseExpiresAt" IS NULL))'
        + ' AND (("state" = \'completed\' AND "decision" IN'
        + ' (\'no_face\', \'single_face\', \'multiple_faces\', \'uncertain\')'
        + ' AND "policyVersion" IS NOT NULL AND length("attestationHash") = 64'
        + ' AND "reviewedAt" IS NOT NULL)'
        + ' OR ("state" <> \'completed\' AND "decision" IS NULL'
        + ' AND "policyVersion" IS NULL AND "attestationHash" IS NULL'
        + ' AND "reviewedAt" IS NULL))'
        + ' AND (("state" = \'released\' AND "releasedAt" IS NOT NULL)'
        + ' OR ("state" <> \'released\' AND "releasedAt" IS NULL))',
      {},
      "chk_o_portrait_manual_review_state",
    );
  });
  await trx.raw(
    `CREATE UNIQUE INDEX ?? ON ?? (??) WHERE ?? IN ('pending', 'claimed')`,
    [
      PORTRAIT_ASSET_INDEXES.manualReviewActive,
      PORTRAIT_MANUAL_REVIEW_TABLE,
      "admissionId",
      "state",
    ],
  );

  await trx.schema.createTable(PORTRAIT_IMAGEX_REVIEW_JOB_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("admissionId").notNullable();
    table.text("workspaceId").notNullable();
    table.bigInteger("projectId").notNullable();
    table.bigInteger("assetVersionId").notNullable();
    table.text("sourceSha256").notNullable();
    table.text("channelId").notNullable();
    table.bigInteger("credentialGeneration").notNullable();
    table.text("dataId").notNullable();
    table.text("sourceUrlHash").notNullable();
    table.text("requestEvidenceHash").notNullable();
    table.text("state").notNullable().defaultTo("prepared");
    table.text("taskIdCiphertext");
    table.text("taskIdHash");
    table.text("pollMarkerCiphertext");
    table.text("pollMarkerHash");
    table.text("resultEvidenceHash");
    table.text("policyVersion").notNullable();
    table.text("safeReasonCode");
    table.text("leaseOwner");
    table.bigInteger("leaseExpiresAt");
    table.bigInteger("submittedAt");
    table.bigInteger("lastPolledAt");
    table.bigInteger("completedAt");
    table.bigInteger("revision").notNullable().defaultTo(0);
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();

    requiredForeignKey(
      table,
      "admissionId",
      PORTRAIT_ADMISSION_TABLE,
      "id",
      "fk_o_portrait_imagex_review_admission",
    );
    // channelId and credentialGeneration are immutable provider snapshots.
    // Do not FK them to the legacy channel table: a schema-47 rollback still
    // owns channel deletion and must not be blocked by additive schema-48
    // compliance evidence.
    table.unique(
      [
        "admissionId",
        "sourceSha256",
        "channelId",
        "credentialGeneration",
        "requestEvidenceHash",
      ],
      PORTRAIT_ASSET_INDEXES.imageXReviewBinding,
    );
    table.index(
      ["state", "updatedAt", "id"],
      PORTRAIT_ASSET_INDEXES.imageXReviewQueue,
    );
    table.index(
      ["admissionId", "createdAt", "id"],
      PORTRAIT_ASSET_INDEXES.imageXReviewAdmission,
    );
    table.index(
      ["workspaceId", "state", "updatedAt"],
      PORTRAIT_ASSET_INDEXES.imageXReviewWorkspace,
    );
    table.check(
      '"state" IN (\'prepared\', \'submitting\', \'polling\', \'submission_unknown\','
        + ' \'allowed\', \'denied\', \'review_required\', \'failed\')'
        + ' AND length("sourceSha256") = 64'
        + ' AND length("sourceUrlHash") = 64'
        + ' AND length("requestEvidenceHash") = 64'
        + ' AND length(trim("dataId")) BETWEEN 1 AND 128'
        + ' AND "projectId" > 0 AND "assetVersionId" > 0'
        + ' AND "credentialGeneration" > 0 AND "revision" >= 0'
        + ' AND (("taskIdCiphertext" IS NULL AND "taskIdHash" IS NULL)'
        + ' OR ("taskIdCiphertext" IS NOT NULL AND length("taskIdHash") = 64))'
        + ' AND (("pollMarkerCiphertext" IS NULL AND "pollMarkerHash" IS NULL)'
        + ' OR ("pollMarkerCiphertext" IS NOT NULL AND length("pollMarkerHash") = 64))'
        + ' AND ("resultEvidenceHash" IS NULL OR length("resultEvidenceHash") = 64)'
        + ' AND (("leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL)'
        + ' OR (length(trim("leaseOwner")) BETWEEN 1 AND 256 AND "leaseExpiresAt" IS NOT NULL))'
        + ' AND ("leaseOwner" IS NULL OR "state" IN (\'submitting\', \'polling\'))'
        + ' AND ("state" <> \'prepared\' OR ("taskIdCiphertext" IS NULL'
        + ' AND "pollMarkerCiphertext" IS NULL AND "leaseOwner" IS NULL'
        + ' AND "submittedAt" IS NULL AND "lastPolledAt" IS NULL'
        + ' AND "completedAt" IS NULL AND "resultEvidenceHash" IS NULL))'
        + ' AND ("state" <> \'polling\' OR ("taskIdCiphertext" IS NOT NULL'
        + ' AND "submittedAt" IS NOT NULL AND "completedAt" IS NULL'
        + ' AND "resultEvidenceHash" IS NULL))'
        + ' AND ("state" NOT IN (\'allowed\', \'denied\', \'review_required\')'
        + ' OR ("taskIdCiphertext" IS NOT NULL AND "submittedAt" IS NOT NULL))'
        + ' AND ("state" NOT IN (\'allowed\', \'denied\', \'review_required\', \'failed\')'
        + ' OR ("completedAt" IS NOT NULL AND "resultEvidenceHash" IS NOT NULL'
        + ' AND "leaseOwner" IS NULL))'
        + ' AND ("state" <> \'submission_unknown\' OR ("completedAt" IS NOT NULL'
        + ' AND "leaseOwner" IS NULL))'
        + ' AND ("pollMarkerCiphertext" IS NULL OR "taskIdCiphertext" IS NOT NULL)',
      {},
      "chk_o_portrait_imagex_review_job_state",
    );
  });

  await trx.schema.alterTable(PORTRAIT_ADMISSION_TABLE, (table) => {
    requiredForeignKey(
      table,
      "currentManualReviewId",
      PORTRAIT_MANUAL_REVIEW_TABLE,
      "id",
      "fk_o_portrait_admission_manual_review",
    );
    requiredForeignKey(
      table,
      "currentImageXReviewJobId",
      PORTRAIT_IMAGEX_REVIEW_JOB_TABLE,
      "id",
      "fk_o_portrait_admission_imagex_review_job",
    );
  });
}

export async function downPortraitAssetAdmission(): Promise<void> {
  throw new Error(
    "Migration portrait_asset_admission cannot be rolled back safely because portrait consent and provider bindings are compliance evidence.",
  );
}
