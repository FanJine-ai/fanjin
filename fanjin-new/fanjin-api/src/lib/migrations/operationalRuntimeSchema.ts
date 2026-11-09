import type { Knex } from "knex";
import { quoteSqlIdentifier, tableIndexRows } from "@/lib/dbDialect";

export const WORKER_HEARTBEAT_TABLE = "o_worker_heartbeat";
export const API_KEY_QUOTA_RESERVATION_TABLE = "o_api_key_quota_reservation";
export const BILLING_RECONCILE_JOB_TABLE = "o_billing_reconcile_job";
export const PROVIDER_CHANNEL_TABLE = "o_provider_channel";

export const OPERATIONAL_RUNTIME_INDEXES = [
  {
    name: "idx_o_worker_heartbeat_role_time",
    table: WORKER_HEARTBEAT_TABLE,
    columns: ["role", "heartbeatAt"],
    unique: false,
  },
  {
    name: "idx_o_api_key_quota_reservation_request",
    table: API_KEY_QUOTA_RESERVATION_TABLE,
    columns: ["apiKeyId", "requestId"],
    unique: true,
  },
  {
    name: "idx_o_api_key_quota_reservation_status_expire",
    table: API_KEY_QUOTA_RESERVATION_TABLE,
    columns: ["status", "expiresAt"],
    unique: false,
  },
  {
    name: "idx_o_billing_reconcile_job_dedupe",
    table: BILLING_RECONCILE_JOB_TABLE,
    columns: ["dedupeKey"],
    unique: true,
  },
  {
    name: "idx_o_billing_reconcile_job_status_next",
    table: BILLING_RECONCILE_JOB_TABLE,
    columns: ["status", "nextAttemptAt"],
    unique: false,
  },
  {
    name: "idx_o_billing_reconcile_job_reservation",
    table: BILLING_RECONCILE_JOB_TABLE,
    columns: ["reservationId"],
    unique: false,
  },
] as const;

async function ensureIndex(
  trx: Knex.Transaction,
  definition: (typeof OPERATIONAL_RUNTIME_INDEXES)[number],
): Promise<void> {
  const indexes = await tableIndexRows(trx, definition.table);
  if (indexes.some((index) => index.name === definition.name)) return;
  await trx.raw(
    `CREATE ${definition.unique ? "UNIQUE " : ""}INDEX ${quoteSqlIdentifier(definition.name)} ON ${quoteSqlIdentifier(definition.table)} (${definition.columns
      .map(quoteSqlIdentifier)
      .join(", ")})`,
  );
}

async function ensureWorkerHeartbeatTable(trx: Knex.Transaction): Promise<void> {
  if (await trx.schema.hasTable(WORKER_HEARTBEAT_TABLE)) return;
  await trx.schema.createTable(WORKER_HEARTBEAT_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("role").notNullable();
    table.text("hostname").notNullable();
    table.bigInteger("processId").notNullable();
    table.bigInteger("startedAt").notNullable();
    table.bigInteger("heartbeatAt").notNullable();
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();
  });
}

async function ensureApiKeyQuotaReservationTable(trx: Knex.Transaction): Promise<void> {
  if (await trx.schema.hasTable(API_KEY_QUOTA_RESERVATION_TABLE)) return;
  await trx.schema.createTable(API_KEY_QUOTA_RESERVATION_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("apiKeyId").notNullable();
    table.text("requestId").notNullable();
    table.bigInteger("units").notNullable().defaultTo(1);
    table.text("status").notNullable().defaultTo("reserved");
    table.bigInteger("responseStatus");
    table.bigInteger("expiresAt").notNullable();
    table.bigInteger("createTime").notNullable();
    table.bigInteger("updateTime").notNullable();
  });
}

async function ensureBillingReconcileJobTable(trx: Knex.Transaction): Promise<void> {
  if (await trx.schema.hasTable(BILLING_RECONCILE_JOB_TABLE)) return;
  await trx.schema.createTable(BILLING_RECONCILE_JOB_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("dedupeKey").notNullable();
    table.text("workspaceId").notNullable();
    table.text("reservationId").notNullable();
    table.text("usageRecordId");
    table.text("requestId");
    table.text("endpointType");
    table.text("provider");
    table.text("channelId");
    table.text("status").notNullable().defaultTo("pending");
    table.text("reason").notNullable();
    table.text("evidence").notNullable().defaultTo("{}");
    table.text("decision");
    table.bigInteger("attempts").notNullable().defaultTo(0);
    table.bigInteger("nextAttemptAt").notNullable();
    table.text("leaseOwner");
    table.bigInteger("leaseExpiresAt");
    table.text("lastError");
    table.bigInteger("resolvedAt");
    table.bigInteger("createTime").notNullable();
    table.bigInteger("updateTime").notNullable();
  });
}

async function ensureProviderFailedCount(trx: Knex.Transaction): Promise<void> {
  if (!(await trx.schema.hasTable(PROVIDER_CHANNEL_TABLE))) {
    throw new Error(
      `${PROVIDER_CHANNEL_TABLE} is missing; restore the legacy baseline schema before applying operational_runtime_schema.`,
    );
  }
  if (!(await trx.schema.hasColumn(PROVIDER_CHANNEL_TABLE, "failedCount"))) {
    await trx.schema.alterTable(PROVIDER_CHANNEL_TABLE, (table) => {
      table.bigInteger("failedCount").notNullable().defaultTo(0);
    });
  }
  await trx(PROVIDER_CHANNEL_TABLE).whereNull("failedCount").update({ failedCount: 0 });
}

/**
 * Additive, idempotent upgrade for runtime structures that were added to the
 * legacy init/fix schema after migration v1 had already shipped. Never rebuild
 * or drop a table: old rows remain in place, and unsafe duplicate data causes
 * unique-index creation to fail closed for operator review.
 */
export async function upOperationalRuntimeSchema(trx: Knex.Transaction): Promise<void> {
  await ensureWorkerHeartbeatTable(trx);
  await ensureApiKeyQuotaReservationTable(trx);
  await ensureBillingReconcileJobTable(trx);
  await ensureProviderFailedCount(trx);
  for (const definition of OPERATIONAL_RUNTIME_INDEXES) await ensureIndex(trx, definition);
}

export async function downOperationalRuntimeSchema(): Promise<void> {
  throw new Error(
    "Migration operational_runtime_schema cannot be rolled back safely because worker leases, quota reservations, and reconciliation evidence may already be in use.",
  );
}
