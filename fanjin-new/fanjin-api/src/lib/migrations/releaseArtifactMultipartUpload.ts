import type { Knex } from "knex";

import {
  RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE,
} from "@/lib/migrations/releaseArtifactGeneration";
import { PLATFORM_RELEASE_TABLE } from "@/lib/migrations/platformRelease";

export const RELEASE_ARTIFACT_MULTIPART_UPLOAD_TABLE =
  "o_release_artifact_multipart_upload";

export const RELEASE_ARTIFACT_MULTIPART_UPLOAD_INDEXES = {
  reservation: "uq_o_release_multipart_reservation",
  releaseStatus: "idx_o_release_multipart_release_status",
  expiry: "idx_o_release_multipart_expiry",
} as const;

export const RELEASE_ARTIFACT_MULTIPART_UPLOAD_REQUIRED_CONSTRAINTS = [
  `table:${RELEASE_ARTIFACT_MULTIPART_UPLOAD_TABLE}`,
  `column:${RELEASE_ARTIFACT_MULTIPART_UPLOAD_TABLE}.resumeGrantHash`,
  `column:${RELEASE_ARTIFACT_MULTIPART_UPLOAD_TABLE}.operatorSessionHash`,
  `column:${RELEASE_ARTIFACT_MULTIPART_UPLOAD_TABLE}.uploadIdCiphertext`,
  `index:${RELEASE_ARTIFACT_MULTIPART_UPLOAD_TABLE}.${RELEASE_ARTIFACT_MULTIPART_UPLOAD_INDEXES.reservation}`,
  `index:${RELEASE_ARTIFACT_MULTIPART_UPLOAD_TABLE}.${RELEASE_ARTIFACT_MULTIPART_UPLOAD_INDEXES.releaseStatus}`,
  `index:${RELEASE_ARTIFACT_MULTIPART_UPLOAD_TABLE}.${RELEASE_ARTIFACT_MULTIPART_UPLOAD_INDEXES.expiry}`,
] as const;

export async function upReleaseArtifactMultipartUpload(
  trx: Knex.Transaction,
): Promise<void> {
  if (await trx.schema.hasTable(RELEASE_ARTIFACT_MULTIPART_UPLOAD_TABLE)) {
    return;
  }
  for (const requiredTable of [
    PLATFORM_RELEASE_TABLE,
    RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE,
  ]) {
    if (!(await trx.schema.hasTable(requiredTable))) {
      throw new Error(
        `Migration release_artifact_multipart_upload requires table ${requiredTable}`,
      );
    }
  }

  await trx.schema.createTable(
    RELEASE_ARTIFACT_MULTIPART_UPLOAD_TABLE,
    (table) => {
      table.text("id").notNullable().primary();
      table.text("reservationId").notNullable();
      table.text("releaseId").notNullable();
      table.bigInteger("operatorUserId").notNullable();
      table.text("operatorSessionHash").notNullable();
      table.text("resumeGrantHash").notNullable();
      table.text("uploadIdCiphertext").notNullable();
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
      table.bigInteger("completedAt");
      table.bigInteger("abortedAt");
      table.bigInteger("expiredAt");
      table.bigInteger("revision").notNullable().defaultTo(1);
      table.bigInteger("createdAt").notNullable();
      table.bigInteger("updatedAt").notNullable();

      table.foreign("reservationId", "fk_o_release_multipart_reservation")
        .references("id")
        .inTable(RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE)
        .onDelete("RESTRICT");
      table.foreign("releaseId", "fk_o_release_multipart_release")
        .references("id")
        .inTable(PLATFORM_RELEASE_TABLE)
        .onDelete("RESTRICT");
      table.unique(
        ["reservationId"],
        RELEASE_ARTIFACT_MULTIPART_UPLOAD_INDEXES.reservation,
      );
      table.index(
        ["releaseId", "status", "createdAt"],
        RELEASE_ARTIFACT_MULTIPART_UPLOAD_INDEXES.releaseStatus,
      );
      table.index(
        ["status", "expiresAt"],
        RELEASE_ARTIFACT_MULTIPART_UPLOAD_INDEXES.expiry,
      );

      table.check(
        '"status" IN (\'active\', \'completing\', \'aborting\','
          + ' \'completed\', \'aborted\', \'expired\')',
        {},
        "chk_o_release_multipart_status",
      );
      table.check(
        '"operatorUserId" > 0'
          + ' AND length("operatorSessionHash") = 64'
          + ' AND length("resumeGrantHash") = 64'
          + ' AND length("declaredSha256") = 64'
          + ' AND "partSize" > 0'
          + ' AND "partCount" BETWEEN 1 AND 10000'
          + ' AND "expiresAt" > "createdAt"'
          + ' AND "revision" >= 1',
        {},
        "chk_o_release_multipart_identity",
      );
      table.check(
        '("status" IN (\'active\', \'completing\', \'aborting\')'
          + ' AND "completedAt" IS NULL'
          + ' AND "abortedAt" IS NULL AND "expiredAt" IS NULL)'
          + ' OR ("status" = \'completed\' AND "completedAt" IS NOT NULL'
          + ' AND "completionEtag" IS NOT NULL'
          + ' AND "completionRequestId" IS NOT NULL)'
          + ' OR ("status" = \'aborted\' AND "abortedAt" IS NOT NULL)'
          + ' OR ("status" = \'expired\' AND "expiredAt" IS NOT NULL)',
        {},
        "chk_o_release_multipart_terminal_state",
      );
    },
  );
}

export async function downReleaseArtifactMultipartUpload(): Promise<void> {
  throw new Error(
    "Migration release_artifact_multipart_upload cannot be rolled back safely because multipart sessions are durable release provenance.",
  );
}
