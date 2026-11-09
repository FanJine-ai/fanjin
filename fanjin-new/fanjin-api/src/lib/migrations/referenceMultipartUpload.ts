import type { Knex } from "knex";

export const REFERENCE_MULTIPART_UPLOAD_TABLE =
  "o_reference_multipart_upload";

export const REFERENCE_MULTIPART_UPLOAD_INDEXES = {
  actorIdempotency: "uq_o_reference_multipart_actor_idempotency",
  storageKey: "uq_o_reference_multipart_storage_key",
  projectStatus: "idx_o_reference_multipart_project_status",
  expiry: "idx_o_reference_multipart_expiry",
} as const;

export const REFERENCE_MULTIPART_UPLOAD_REQUIRED_CONSTRAINTS = [
  `table:${REFERENCE_MULTIPART_UPLOAD_TABLE}`,
  `column:${REFERENCE_MULTIPART_UPLOAD_TABLE}.workspaceId`,
  `column:${REFERENCE_MULTIPART_UPLOAD_TABLE}.projectId`,
  `column:${REFERENCE_MULTIPART_UPLOAD_TABLE}.actorUserId`,
  `column:${REFERENCE_MULTIPART_UPLOAD_TABLE}.storageKey`,
  `column:${REFERENCE_MULTIPART_UPLOAD_TABLE}.declaredSha256`,
  `column:${REFERENCE_MULTIPART_UPLOAD_TABLE}.partSize`,
  `column:${REFERENCE_MULTIPART_UPLOAD_TABLE}.partCount`,
  `column:${REFERENCE_MULTIPART_UPLOAD_TABLE}.uploadIdCiphertext`,
  `column:${REFERENCE_MULTIPART_UPLOAD_TABLE}.resumeGrantHash`,
  `column:${REFERENCE_MULTIPART_UPLOAD_TABLE}.status`,
  `column:${REFERENCE_MULTIPART_UPLOAD_TABLE}.expiresAt`,
  `index:${REFERENCE_MULTIPART_UPLOAD_TABLE}.${REFERENCE_MULTIPART_UPLOAD_INDEXES.actorIdempotency}`,
  `index:${REFERENCE_MULTIPART_UPLOAD_TABLE}.${REFERENCE_MULTIPART_UPLOAD_INDEXES.storageKey}`,
  `index:${REFERENCE_MULTIPART_UPLOAD_TABLE}.${REFERENCE_MULTIPART_UPLOAD_INDEXES.projectStatus}`,
  `index:${REFERENCE_MULTIPART_UPLOAD_TABLE}.${REFERENCE_MULTIPART_UPLOAD_INDEXES.expiry}`,
] as const;

/**
 * Additive project-reference upload state. Existing binaries do not read this
 * table, therefore schema 44 remains binary-compatible during the 44/45
 * rolling window.
 */
export async function upReferenceMultipartUpload(
  trx: Knex.Transaction,
): Promise<void> {
  if (await trx.schema.hasTable(REFERENCE_MULTIPART_UPLOAD_TABLE)) return;
  for (const parent of [
    "o_workspace",
    "o_project",
    "o_user",
    "o_assets",
    "o_image",
  ]) {
    if (!(await trx.schema.hasTable(parent))) {
      throw new Error(
        `Migration reference_multipart_upload requires table ${parent}`,
      );
    }
  }

  await trx.schema.createTable(REFERENCE_MULTIPART_UPLOAD_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("workspaceId").notNullable();
    table.bigInteger("projectId").notNullable();
    table.bigInteger("actorUserId").notNullable();
    table.text("idempotencyKey").notNullable();
    table.text("requestHash").notNullable();
    table.text("resumeGrantHash").notNullable();
    table.text("uploadIdCiphertext").notNullable();

    table.text("storageProvider").notNullable();
    table.text("storageBucket").notNullable();
    table.text("storageRegion").notNullable();
    table.text("storageEndpoint").notNullable();
    table.text("storageKeyPrefix").notNullable().defaultTo("");
    table.boolean("storageForcePathStyle").notNullable().defaultTo(false);
    table.text("storageKey").notNullable();

    table.text("fileName").notNullable();
    table.text("mediaType").notNullable();
    table.text("declaredMimeType").notNullable();
    table.bigInteger("declaredByteSize").notNullable();
    table.text("declaredSha256").notNullable();
    table.bigInteger("partSize").notNullable();
    table.integer("partCount").notNullable();
    table.text("providerInitiateRequestId").notNullable();

    table.text("status").notNullable().defaultTo("active");
    table.bigInteger("expiresAt").notNullable();
    table.text("completionEtag");
    table.text("completionVersionId");
    table.text("completionRequestId");
    table.text("abortRequestId");
    table.bigInteger("assetId");
    table.bigInteger("assetVersionId");
    table.text("actualSha256");
    table.text("detectedMimeType");
    table.text("probeJson");
    table.text("errorCode");
    table.bigInteger("completedAt");
    table.bigInteger("abortedAt");
    table.bigInteger("failedAt");
    table.bigInteger("revision").notNullable().defaultTo(1);
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();

    table.foreign("workspaceId", "fk_o_reference_multipart_workspace")
      .references("id").inTable("o_workspace").onDelete("RESTRICT");
    table.foreign("projectId", "fk_o_reference_multipart_project")
      .references("id").inTable("o_project").onDelete("RESTRICT");
    table.foreign("actorUserId", "fk_o_reference_multipart_actor")
      .references("id").inTable("o_user").onDelete("RESTRICT");
    table.foreign("assetId", "fk_o_reference_multipart_asset")
      .references("id").inTable("o_assets").onDelete("RESTRICT");
    table.foreign("assetVersionId", "fk_o_reference_multipart_version")
      .references("id").inTable("o_image").onDelete("RESTRICT");

    table.unique(
      ["workspaceId", "projectId", "actorUserId", "idempotencyKey"],
      REFERENCE_MULTIPART_UPLOAD_INDEXES.actorIdempotency,
    );
    table.unique(["storageKey"], REFERENCE_MULTIPART_UPLOAD_INDEXES.storageKey);
    table.index(
      ["workspaceId", "projectId", "status", "createdAt"],
      REFERENCE_MULTIPART_UPLOAD_INDEXES.projectStatus,
    );
    table.index(
      ["status", "expiresAt"],
      REFERENCE_MULTIPART_UPLOAD_INDEXES.expiry,
    );

    table.check(
      '"status" IN (\'active\', \'completing\', \'verifying\','
        + ' \'completed\', \'aborting\', \'aborted\', \'failed\')',
      {},
      "chk_o_reference_multipart_status",
    );
    table.check(
      '"mediaType" IN (\'image\', \'video\', \'audio\')'
        + ' AND "storageProvider" IN (\'s3\', \'tos\')'
        + ' AND "projectId" > 0 AND "actorUserId" > 0'
        + ' AND length("requestHash") = 64'
        + ' AND length("resumeGrantHash") = 64'
        + ' AND length("declaredSha256") = 64'
        + ' AND "declaredByteSize" > 0'
        + ' AND "partSize" > 0'
        + ' AND "partCount" BETWEEN 1 AND 10000'
        + ' AND "expiresAt" > "createdAt"'
        + ' AND "revision" >= 1',
      {},
      "chk_o_reference_multipart_identity",
    );
    table.check(
      '("status" = \'completed\' AND "completedAt" IS NOT NULL'
        + ' AND "assetId" IS NOT NULL AND "assetVersionId" IS NOT NULL'
        + ' AND length("actualSha256") = 64'
        + ' AND "completionEtag" IS NOT NULL'
        + ' AND "completionRequestId" IS NOT NULL)'
        + ' OR ("status" = \'aborted\' AND "abortedAt" IS NOT NULL)'
        + ' OR ("status" = \'failed\' AND "failedAt" IS NOT NULL'
        + ' AND "errorCode" IS NOT NULL)'
        + ' OR ("status" IN (\'active\', \'completing\', \'verifying\','
        + ' \'aborting\') AND "completedAt" IS NULL'
        + ' AND "abortedAt" IS NULL AND "failedAt" IS NULL)',
      {},
      "chk_o_reference_multipart_terminal_state",
    );
  });
}

export async function downReferenceMultipartUpload(): Promise<void> {
  throw new Error(
    "Migration reference_multipart_upload cannot be rolled back safely because upload sessions bind durable object generations to project assets.",
  );
}
