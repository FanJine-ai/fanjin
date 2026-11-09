import type { Knex } from "knex";

import { PLATFORM_RELEASE_TABLE } from "@/lib/migrations/platformRelease";
import {
  RELEASE_ARTIFACT_TABLE,
} from "@/lib/migrations/releaseDeploymentOrchestration";

export const RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE =
  "o_release_artifact_upload_reservation";

export const RELEASE_ARTIFACT_UPLOAD_RESERVATION_INDEXES = {
  operatorIdempotency: "uq_o_release_upload_operator_idempotency",
  storageKey: "uq_o_release_upload_storage_key",
  expiry: "idx_o_release_upload_expiry",
  releaseStatus: "idx_o_release_upload_release_status",
  artifact: "uq_o_release_upload_artifact",
} as const;

export const RELEASE_ARTIFACT_GENERATION_INDEXES = {
  reservation: "uq_o_release_artifact_upload_reservation",
} as const;

const ARTIFACT_GENERATION_COLUMNS = [
  "uploadReservationId",
  "storageProvider",
  "storageBucket",
  "storageRegion",
  "storageEndpoint",
  "storageKeyPrefix",
  "storageForcePathStyle",
  "storageVersionId",
  "storageEtag",
  "storageRequestId",
  "storageCapturedAt",
] as const;

async function ensureReservationTable(
  trx: Knex.Transaction,
): Promise<void> {
  if (await trx.schema.hasTable(RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE)) {
    return;
  }
  await trx.schema.createTable(
    RELEASE_ARTIFACT_UPLOAD_RESERVATION_TABLE,
    (table) => {
      table.text("id").notNullable().primary();
      table.text("releaseId").notNullable();
      table.bigInteger("operatorUserId").notNullable();
      table.text("idempotencyKey").notNullable();
      table.text("requestHash").notNullable();
      table.text("storageKey").notNullable();
      table.text("fileName").notNullable();
      table.bigInteger("declaredByteSize").notNullable();
      table.text("contentType").notNullable();
      table.text("storageProvider").notNullable();
      table.text("storageBucket").notNullable();
      table.text("storageRegion").notNullable();
      table.text("storageEndpoint").notNullable();
      table.text("storageKeyPrefix").notNullable();
      table.boolean("storageForcePathStyle").notNullable();
      table.text("status").notNullable().defaultTo("pending");
      table.bigInteger("expiresAt").notNullable();
      table.text("finalizedArtifactId");
      table.bigInteger("finalizedAt");
      table.bigInteger("revision").notNullable().defaultTo(1);
      table.bigInteger("createdAt").notNullable();
      table.bigInteger("updatedAt").notNullable();

      table
        .foreign("releaseId", "fk_o_release_upload_release")
        .references("id")
        .inTable(PLATFORM_RELEASE_TABLE)
        .onDelete("RESTRICT");
      table
        .foreign("finalizedArtifactId", "fk_o_release_upload_artifact")
        .references("id")
        .inTable(RELEASE_ARTIFACT_TABLE)
        .onDelete("RESTRICT");
      table.unique(
        ["operatorUserId", "idempotencyKey"],
        RELEASE_ARTIFACT_UPLOAD_RESERVATION_INDEXES.operatorIdempotency,
      );
      table.unique(
        ["storageKey"],
        RELEASE_ARTIFACT_UPLOAD_RESERVATION_INDEXES.storageKey,
      );
      table.unique(
        ["finalizedArtifactId"],
        RELEASE_ARTIFACT_UPLOAD_RESERVATION_INDEXES.artifact,
      );
      table.index(
        ["status", "expiresAt"],
        RELEASE_ARTIFACT_UPLOAD_RESERVATION_INDEXES.expiry,
      );
      table.index(
        ["releaseId", "status", "createdAt"],
        RELEASE_ARTIFACT_UPLOAD_RESERVATION_INDEXES.releaseStatus,
      );

      table.check(
        "\"status\" IN ('pending', 'finalized')",
        {},
        "chk_o_release_upload_status",
      );
      table.check(
        '"operatorUserId" > 0 AND "declaredByteSize" > 0'
          + ' AND "expiresAt" > "createdAt"'
          + ' AND length("requestHash") = 64'
          + ' AND "revision" >= 1',
        {},
        "chk_o_release_upload_identity",
      );
      table.check(
        '("status" = \'pending\' AND "finalizedArtifactId" IS NULL'
          + ' AND "finalizedAt" IS NULL)'
          + ' OR ("status" = \'finalized\' AND "finalizedArtifactId" IS NOT NULL'
          + ' AND "finalizedAt" IS NOT NULL)',
        {},
        "chk_o_release_upload_finalization",
      );
      table.check(
        "\"storageProvider\" IN ('s3', 'tos')",
        {},
        "chk_o_release_upload_provider",
      );
    },
  );
}

async function ensureArtifactGenerationColumns(
  trx: Knex.Transaction,
): Promise<void> {
  const existing = new Set(
    await Promise.all(
      ARTIFACT_GENERATION_COLUMNS.map(async (column) => [
        column,
        await trx.schema.hasColumn(RELEASE_ARTIFACT_TABLE, column),
      ] as const),
    ).then((entries) => entries.filter(([, present]) => present)
      .map(([column]) => column)),
  );
  if (existing.size !== ARTIFACT_GENERATION_COLUMNS.length) {
    await trx.schema.alterTable(RELEASE_ARTIFACT_TABLE, (table) => {
      if (!existing.has("uploadReservationId")) {
        table.text("uploadReservationId");
      }
      if (!existing.has("storageProvider")) table.text("storageProvider");
      if (!existing.has("storageBucket")) table.text("storageBucket");
      if (!existing.has("storageRegion")) table.text("storageRegion");
      if (!existing.has("storageEndpoint")) table.text("storageEndpoint");
      if (!existing.has("storageKeyPrefix")) table.text("storageKeyPrefix");
      if (!existing.has("storageForcePathStyle")) {
        table.boolean("storageForcePathStyle");
      }
      if (!existing.has("storageVersionId")) table.text("storageVersionId");
      if (!existing.has("storageEtag")) table.text("storageEtag");
      if (!existing.has("storageRequestId")) table.text("storageRequestId");
      if (!existing.has("storageCapturedAt")) {
        table.bigInteger("storageCapturedAt");
      }
    });
  }

  // PostgreSQL marks the whole transaction failed after a duplicate-index
  // error, even when JavaScript catches it. Use the dialect-supported
  // idempotent form so a resumed migration never poisons its transaction.
  await trx.raw("CREATE UNIQUE INDEX IF NOT EXISTS ?? ON ?? (??)", [
    RELEASE_ARTIFACT_GENERATION_INDEXES.reservation,
    RELEASE_ARTIFACT_TABLE,
    "uploadReservationId",
  ]);
}

export async function upReleaseArtifactGeneration(
  trx: Knex.Transaction,
): Promise<void> {
  const required = await Promise.all([
    trx.schema.hasTable(PLATFORM_RELEASE_TABLE),
    trx.schema.hasTable(RELEASE_ARTIFACT_TABLE),
  ]);
  if (required.some((present) => !present)) {
    throw new Error(
      "release artifact generation requires platform release and artifact tables",
    );
  }
  await ensureReservationTable(trx);
  await ensureArtifactGenerationColumns(trx);
}

export async function downReleaseArtifactGeneration(): Promise<void> {
  throw new Error(
    "Migration release_artifact_generation cannot be rolled back safely because upload reservations and exact provider generations are release provenance.",
  );
}
