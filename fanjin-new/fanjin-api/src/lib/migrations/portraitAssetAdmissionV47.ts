import type { Knex } from "knex";

/** Immutable schema-47 snapshot. Never revise this module in place. */
export const PORTRAIT_ADMISSION_TABLE = "o_portrait_admission";
export const PORTRAIT_IDENTITY_TABLE = "o_portrait_identity";
export const PORTRAIT_CONSENT_TABLE = "o_portrait_consent";
export const PORTRAIT_PROVIDER_GROUP_TABLE = "o_portrait_provider_group";
export const PORTRAIT_PROVIDER_ASSET_TABLE = "o_portrait_provider_asset";
export const PORTRAIT_AUTH_SESSION_TABLE = "o_portrait_auth_session";

export const PORTRAIT_ASSET_INDEXES = {
  admissionAssetVersion: "uq_o_portrait_admission_asset_version",
  admissionProjectState: "idx_o_portrait_admission_project_state",
  admissionSyncState: "idx_o_portrait_admission_sync_state",
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
} as const;

export const PORTRAIT_ASSET_ADMISSION_V47_REQUIRED_CONSTRAINTS = [
  `table:${PORTRAIT_ADMISSION_TABLE}`,
  `table:${PORTRAIT_IDENTITY_TABLE}`,
  `table:${PORTRAIT_CONSENT_TABLE}`,
  `table:${PORTRAIT_PROVIDER_GROUP_TABLE}`,
  `table:${PORTRAIT_PROVIDER_ASSET_TABLE}`,
  `table:${PORTRAIT_AUTH_SESSION_TABLE}`,
  `primary-key:${PORTRAIT_ADMISSION_TABLE}.id`,
  `primary-key:${PORTRAIT_IDENTITY_TABLE}.id`,
  `primary-key:${PORTRAIT_CONSENT_TABLE}.id`,
  `primary-key:${PORTRAIT_PROVIDER_GROUP_TABLE}.id`,
  `primary-key:${PORTRAIT_PROVIDER_ASSET_TABLE}.id`,
  `primary-key:${PORTRAIT_AUTH_SESSION_TABLE}.id`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.workspaceId`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.projectId`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.assetId`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.assetVersionId`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.mediaType`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.faceScanState`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.subjectKind`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.declarationState`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.moderationState`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.complianceState`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.providerSyncState`,
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
  `column:${PORTRAIT_ADMISSION_TABLE}.assetVersionId`,
  `column:${PORTRAIT_ADMISSION_TABLE}.faceScanState`,
  `column:${PORTRAIT_ADMISSION_TABLE}.subjectKind`,
  `column:${PORTRAIT_ADMISSION_TABLE}.moderationState`,
  `column:${PORTRAIT_ADMISSION_TABLE}.complianceState`,
  `column:${PORTRAIT_ADMISSION_TABLE}.providerSyncState`,
  `column:${PORTRAIT_PROVIDER_GROUP_TABLE}.groupType`,
  `column:${PORTRAIT_PROVIDER_GROUP_TABLE}.providerAccountFingerprint`,
  `column:${PORTRAIT_PROVIDER_ASSET_TABLE}.providerAssetId`,
  `column:${PORTRAIT_AUTH_SESSION_TABLE}.callbackNonceHash`,
  `index:${PORTRAIT_ADMISSION_TABLE}.${PORTRAIT_ASSET_INDEXES.admissionAssetVersion}`,
  `index:${PORTRAIT_ADMISSION_TABLE}.${PORTRAIT_ASSET_INDEXES.admissionProjectState}`,
  `index:${PORTRAIT_ADMISSION_TABLE}.${PORTRAIT_ASSET_INDEXES.admissionSyncState}`,
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
 * retained as first-party compliance evidence. Schema-46 binaries ignore all
 * six tables, so the 46/47 rolling window is binary compatible.
 */
export async function upPortraitAssetAdmissionV47(
  trx: Knex.Transaction,
): Promise<void> {
  const tables = [
    PORTRAIT_ADMISSION_TABLE,
    PORTRAIT_IDENTITY_TABLE,
    PORTRAIT_CONSENT_TABLE,
    PORTRAIT_PROVIDER_GROUP_TABLE,
    PORTRAIT_PROVIDER_ASSET_TABLE,
    PORTRAIT_AUTH_SESSION_TABLE,
  ];
  const existing = await Promise.all(tables.map((table) => trx.schema.hasTable(table)));
  if (existing.every(Boolean)) return;
  if (existing.some(Boolean)) {
    throw new Error("Migration portrait_asset_admission found a partial schema-47 installation");
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
      '"kind" IN (\'real_person\', \'virtual_person\')'
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
    table.text("faceScanState").notNullable().defaultTo("queued");
    table.integer("faceCount");
    table.text("detectorName");
    table.text("detectorVersion");
    table.float("detectorConfidence");
    table.text("detectorEvidenceHash");
    table.text("detectorEvidenceJson").notNullable().defaultTo("{}");
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
    table.check(
      '"mediaType" IN (\'image\', \'video\')'
        + ' AND "faceScanState" IN (\'queued\', \'scanning\', \'no_face\','
        + ' \'single_face\', \'multiple_faces\', \'uncertain\', \'failed\')'
        + ' AND "subjectKind" IN (\'pending\', \'ordinary\', \'real_person\','
        + ' \'virtual_person\', \'trusted_output\', \'ambiguous\', \'multiple_faces\')'
        + ' AND "declarationState" IN (\'not_required\', \'pending\', \'confirmed\', \'revoked\')'
        + ' AND "moderationState" IN (\'pending\', \'checking\', \'allowed\', \'denied\', \'failed\')'
        + ' AND "complianceState" IN (\'pending\', \'not_required\', \'allowed\','
        + ' \'denied\', \'expired\', \'revoked\')'
        + ' AND "providerSyncState" IN (\'not_needed\', \'queued\', \'authorizing\','
        + ' \'creating_group\', \'processing\', \'active\', \'failed\', \'stale\')'
        + ' AND ("sourceSha256" IS NULL OR length("sourceSha256") = 64)'
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
}

export async function downPortraitAssetAdmissionV47(): Promise<void> {
  throw new Error(
    "Migration portrait_asset_admission cannot be rolled back safely because portrait consent and provider bindings are compliance evidence.",
  );
}
