import type { Knex } from "knex";

import { isPostgresClient } from "@/lib/dbDialect";
import {
  COMMERCIAL_TENANT_RUNTIME_REPAIR_REQUIRED_CONSTRAINTS,
  upCommercialTenantRuntimeRepair,
} from "@/lib/migrations/commercialTenantRuntimeRepair";
import {
  PORTRAIT_ADMISSION_TABLE,
  PORTRAIT_ASSET_INDEXES,
  PORTRAIT_AUTH_SESSION_TABLE,
  PORTRAIT_CONSENT_TABLE,
  PORTRAIT_IDENTITY_TABLE,
  PORTRAIT_IMAGEX_REVIEW_JOB_TABLE,
  PORTRAIT_MANUAL_REVIEW_TABLE,
  PORTRAIT_PROVIDER_ASSET_TABLE,
  PORTRAIT_PROVIDER_GROUP_TABLE,
} from "@/lib/migrations/portraitAssetAdmission";

export const PORTRAIT_ASSET_REVIEW_RUNTIME_CHECK =
  "chk_o_portrait_admission_runtime_v48";
export const PORTRAIT_ASSET_REVIEW_RUNTIME_SQLITE_INSERT_TRIGGER =
  "trg_o_portrait_admission_runtime_v48_insert";
export const PORTRAIT_ASSET_REVIEW_RUNTIME_SQLITE_UPDATE_TRIGGER =
  "trg_o_portrait_admission_runtime_v48_update";

export const PORTRAIT_ASSET_REVIEW_RUNTIME_REQUIRED_CONSTRAINTS = [
  ...COMMERCIAL_TENANT_RUNTIME_REPAIR_REQUIRED_CONSTRAINTS,
  `table:${PORTRAIT_MANUAL_REVIEW_TABLE}`,
  `table:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}`,
  `primary-key:${PORTRAIT_MANUAL_REVIEW_TABLE}.id`,
  `primary-key:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}.id`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.faceScanCoverage`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.manualReviewState`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.sourceRecoveryState`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.sourceRecoveryAttempts`,
  `not-null:${PORTRAIT_ADMISSION_TABLE}.sourceRecoveryNextAttemptAt`,
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
  `column:${PORTRAIT_ADMISSION_TABLE}.faceScanCoverage`,
  `column:${PORTRAIT_ADMISSION_TABLE}.manualReviewState`,
  `column:${PORTRAIT_ADMISSION_TABLE}.currentManualReviewId`,
  `column:${PORTRAIT_ADMISSION_TABLE}.manualReviewDecision`,
  `column:${PORTRAIT_ADMISSION_TABLE}.currentImageXReviewJobId`,
  `column:${PORTRAIT_ADMISSION_TABLE}.sourceRecoveryObjectIdentityJson`,
  `column:${PORTRAIT_ADMISSION_TABLE}.sourceRecoveryFailureCode`,
  `column:${PORTRAIT_ADMISSION_TABLE}.sourceRecoveryFailureMessage`,
  `index:${PORTRAIT_ADMISSION_TABLE}.${PORTRAIT_ASSET_INDEXES.admissionSourceRecovery}`,
  `index:${PORTRAIT_MANUAL_REVIEW_TABLE}.${PORTRAIT_ASSET_INDEXES.manualReviewIdempotency}`,
  `index:${PORTRAIT_MANUAL_REVIEW_TABLE}.${PORTRAIT_ASSET_INDEXES.manualReviewActive}`,
  `index:${PORTRAIT_MANUAL_REVIEW_TABLE}.${PORTRAIT_ASSET_INDEXES.manualReviewQueue}`,
  `index:${PORTRAIT_MANUAL_REVIEW_TABLE}.${PORTRAIT_ASSET_INDEXES.manualReviewAdmin}`,
  `index:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}.${PORTRAIT_ASSET_INDEXES.imageXReviewBinding}`,
  `index:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}.${PORTRAIT_ASSET_INDEXES.imageXReviewQueue}`,
  `index:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}.${PORTRAIT_ASSET_INDEXES.imageXReviewAdmission}`,
  `index:${PORTRAIT_IMAGEX_REVIEW_JOB_TABLE}.${PORTRAIT_ASSET_INDEXES.imageXReviewWorkspace}`,
] as const;

const BASE_TABLES = Object.freeze([
  PORTRAIT_ADMISSION_TABLE,
  PORTRAIT_IDENTITY_TABLE,
  PORTRAIT_CONSENT_TABLE,
  PORTRAIT_PROVIDER_GROUP_TABLE,
  PORTRAIT_PROVIDER_ASSET_TABLE,
  PORTRAIT_AUTH_SESSION_TABLE,
]);

const REVIEW_TABLES = Object.freeze([
  PORTRAIT_MANUAL_REVIEW_TABLE,
  PORTRAIT_IMAGEX_REVIEW_JOB_TABLE,
]);

const ADMISSION_V48_COLUMNS = Object.freeze([
  "sourceRecoveryState",
  "sourceRecoveryAttempts",
  "sourceRecoveryNextAttemptAt",
  "sourceRecoveryLeaseOwner",
  "sourceRecoveryLeaseExpiresAt",
  "sourceRecoveryObjectIdentityJson",
  "sourceRecoveryFailureCode",
  "sourceRecoveryFailureMessage",
  "faceScanCoverage",
  "manualReviewState",
  "currentManualReviewId",
  "manualReviewDecision",
  "manualReviewEvidenceHash",
  "manualReviewPolicyVersion",
  "manualReviewedByUserId",
  "manualReviewedAt",
  "currentImageXReviewJobId",
]);

const ADMISSION_V48_CHECK_SQL =
  '"faceScanCoverage" IN (\'none\', \'full_image\', \'sampled_video\', \'full_video_manual\')'
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
  + ' OR "sourceRecoveryState" <> \'terminal\')';

const ADMISSION_V48_SQLITE_CHECK_SQL = ADMISSION_V48_CHECK_SQL.replace(
  /"([A-Za-z][A-Za-z0-9]*)"/gu,
  'NEW."$1"',
);

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

async function tableStates(
  trx: Knex.Transaction,
  tables: readonly string[],
): Promise<boolean[]> {
  return Promise.all(tables.map((table) => trx.schema.hasTable(table)));
}

async function v48ColumnStates(trx: Knex.Transaction): Promise<boolean[]> {
  return Promise.all(ADMISSION_V48_COLUMNS.map((column) => (
    trx.schema.hasColumn(PORTRAIT_ADMISSION_TABLE, column)
  )));
}

async function installAdmissionRuntimeIntegrity(trx: Knex.Transaction): Promise<void> {
  if (isPostgresClient(trx)) {
    await trx.raw(
      `ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (${ADMISSION_V48_CHECK_SQL})`,
      [PORTRAIT_ADMISSION_TABLE, PORTRAIT_ASSET_REVIEW_RUNTIME_CHECK],
    );
    return;
  }
  await trx.raw(
    `CREATE TRIGGER ?? BEFORE INSERT ON ?? FOR EACH ROW
       WHEN NOT (${ADMISSION_V48_SQLITE_CHECK_SQL})
       BEGIN SELECT RAISE(ABORT, 'portrait admission runtime v48 check failed'); END`,
    [
      PORTRAIT_ASSET_REVIEW_RUNTIME_SQLITE_INSERT_TRIGGER,
      PORTRAIT_ADMISSION_TABLE,
    ],
  );
  await trx.raw(
    `CREATE TRIGGER ?? BEFORE UPDATE ON ?? FOR EACH ROW
       WHEN NOT (${ADMISSION_V48_SQLITE_CHECK_SQL})
       BEGIN SELECT RAISE(ABORT, 'portrait admission runtime v48 check failed'); END`,
    [
      PORTRAIT_ASSET_REVIEW_RUNTIME_SQLITE_UPDATE_TRIGGER,
      PORTRAIT_ADMISSION_TABLE,
    ],
  );
}

async function createManualReviewTable(trx: Knex.Transaction): Promise<void> {
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

    requiredForeignKey(
      table,
      "admissionId",
      PORTRAIT_ADMISSION_TABLE,
      "id",
      "fk_o_portrait_manual_review_admission",
    );
    // claimOwnerUserId is an immutable audit snapshot. It deliberately has no
    // legacy o_user FK so a schema-47 binary rollback can still delete users.
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
}

async function createImageXReviewTable(trx: Knex.Transaction): Promise<void> {
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
}

/**
 * Additive schema-48 delta. It requires the immutable six-table schema-47
 * contract, repairs the exact mutable-baseline drift present in the deployed
 * schema 40, and never rewrites v47's ledger identity or original check.
 */
export async function upPortraitAssetReviewRuntime(
  trx: Knex.Transaction,
): Promise<void> {
  const base = await tableStates(trx, BASE_TABLES);
  if (!base.every(Boolean)) {
    throw new Error(
      "Migration portrait_asset_review_runtime requires the complete immutable schema-47 installation",
    );
  }
  const review = await tableStates(trx, REVIEW_TABLES);
  const columns = await v48ColumnStates(trx);
  const portraitRuntimeComplete = review.every(Boolean) && columns.every(Boolean);
  if (!portraitRuntimeComplete && (review.some(Boolean) || columns.some(Boolean))) {
    throw new Error(
      "Migration portrait_asset_review_runtime found a partial schema-48 installation",
    );
  }

  await upCommercialTenantRuntimeRepair(trx);
  if (portraitRuntimeComplete) return;

  await trx.schema.alterTable(PORTRAIT_ADMISSION_TABLE, (table) => {
    table.text("sourceRecoveryState").notNullable().defaultTo("pending");
    table.integer("sourceRecoveryAttempts").notNullable().defaultTo(0);
    table.bigInteger("sourceRecoveryNextAttemptAt").notNullable().defaultTo(0);
    table.text("sourceRecoveryLeaseOwner");
    table.bigInteger("sourceRecoveryLeaseExpiresAt");
    table.text("sourceRecoveryObjectIdentityJson");
    table.text("sourceRecoveryFailureCode");
    table.text("sourceRecoveryFailureMessage");
    table.text("faceScanCoverage").notNullable().defaultTo("none");
    table.text("manualReviewState").notNullable().defaultTo("not_required");
    table.text("currentManualReviewId");
    table.text("manualReviewDecision");
    table.text("manualReviewEvidenceHash");
    table.text("manualReviewPolicyVersion");
    table.bigInteger("manualReviewedByUserId");
    table.bigInteger("manualReviewedAt");
    table.text("currentImageXReviewJobId");
  });

  const migratedIdentity = JSON.stringify({
    authority: "fanjin_committed_upload_evidence",
    version: "portrait-source-object-identity/v1",
  });
  await trx(PORTRAIT_ADMISSION_TABLE)
    .whereNotNull("sourceSha256")
    .update({
      sourceRecoveryState: "ready",
      sourceRecoveryObjectIdentityJson: migratedIdentity,
    });

  await trx.schema.alterTable(PORTRAIT_ADMISSION_TABLE, (table) => {
    table.index(
      ["sourceRecoveryState", "sourceRecoveryNextAttemptAt", "sourceRecoveryLeaseExpiresAt"],
      PORTRAIT_ASSET_INDEXES.admissionSourceRecovery,
    );
  });
  await installAdmissionRuntimeIntegrity(trx);
  await createManualReviewTable(trx);
  await createImageXReviewTable(trx);

  if (isPostgresClient(trx)) {
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
}

export async function downPortraitAssetReviewRuntime(): Promise<void> {
  throw new Error(
    "Migration portrait_asset_review_runtime cannot be rolled back safely because review and provider evidence is retained; use the approved schema-47 binary compatibility window.",
  );
}
