import type { Knex } from "knex";

import { isPostgresClient, quoteSqlIdentifier } from "@/lib/dbDialect";
import {
  SERVICE_REQUEST_V1_RUNTIME_CHECKS,
  SERVICE_REQUEST_V1_RUNTIME_INDEXES,
} from "@/lib/serviceRequestV1Schema";

const REQUEST_TABLE = "o_billing_service_request";

const requestColumns = {
  contractVersion: "text",
  compatibilityStatus: "text",
  payload: "text",
  decision: "text",
  financeState: "text",
  financeResult: "text",
  submissionEvidenceId: "text",
  submissionIdempotencyKey: "text",
  submissionPayloadHash: "text",
  reviewEvidenceId: "text",
  revision: "bigInteger",
} as const;

export const SERVICE_REQUEST_V1_REQUIRED_CONSTRAINTS = [
  "column:o_user.authorizationRevision",
  "column:o_auth_token.revokedAt",
  ...Object.keys(requestColumns).map((column) => `column:${REQUEST_TABLE}.${column}`),
  "table:o_billing_service_request_command",
  "table:o_billing_finance_intent",
  "table:o_billing_outbox",
  "table:o_billing_audit_log",
  "table:o_billing_watchdog_lease",
  "table:o_billing_finance_worker",
  ...SERVICE_REQUEST_V1_RUNTIME_INDEXES.map(
    ({ table, name }) => `index:${table}.${name}`,
  ),
  "index:o_billing_service_request.uq_billing_service_request_submission_idempotency",
] as const;

async function addColumn(
  trx: Knex.Transaction,
  tableName: string,
  columnName: string,
  type: "text" | "bigInteger",
): Promise<void> {
  if (await trx.schema.hasColumn(tableName, columnName)) return;
  await trx.schema.alterTable(tableName, (table) => {
    if (type === "bigInteger") table.bigInteger(columnName);
    else table.text(columnName);
  });
}

async function requireTable(
  trx: Knex.Transaction,
  tableName: string,
): Promise<void> {
  if (!(await trx.schema.hasTable(tableName))) {
    throw new Error(
      `Migration service_request_v1_runtime requires table ${tableName}`,
    );
  }
}

async function createRuntimeTables(trx: Knex.Transaction): Promise<void> {
  if (!(await trx.schema.hasTable("o_billing_service_request_command"))) {
    await trx.schema.createTable("o_billing_service_request_command", (table) => {
      table.text("id").notNullable().primary();
      table.text("operation").notNullable();
      table.text("requestId").notNullable();
      table.text("workspaceId").notNullable();
      table.text("idempotencyKey").notNullable();
      table.text("commandHash").notNullable();
      table.text("proofRecordId").notNullable();
      table.text("outcome").notNullable();
      table.bigInteger("outcomeRevision").notNullable();
      table.bigInteger("createdAt").notNullable();
    });
  }
  if (!(await trx.schema.hasTable("o_billing_finance_intent"))) {
    await trx.schema.createTable("o_billing_finance_intent", (table) => {
      table.text("id").notNullable().primary();
      table.text("operation").notNullable();
      table.text("requestId").notNullable();
      table.text("workspaceId").notNullable();
      table.text("requestType").notNullable();
      table.text("idempotencyKey").notNullable();
      table.text("commandHash").notNullable();
      table.text("payloadHashVersion").notNullable();
      table.text("payloadHash").notNullable();
      table.bigInteger("lockedRevision").notNullable();
      table.text("durableAuditIntentId").notNullable();
      table.text("outboxIds").notNullable();
      table.text("status").notNullable();
      table.text("financeResult");
      table.text("errorMessage");
      table.bigInteger("committedAt").notNullable();
      table.bigInteger("createdAt").notNullable();
      table.bigInteger("updatedAt").notNullable();
    });
  }
  if (!(await trx.schema.hasTable("o_billing_outbox"))) {
    await trx.schema.createTable("o_billing_outbox", (table) => {
      table.text("id").notNullable().primary();
      table.text("aggregateType").notNullable();
      table.text("aggregateId").notNullable();
      table.text("eventType").notNullable();
      table.text("payload").notNullable();
      table.text("status").notNullable();
      table.bigInteger("availableAt").notNullable();
      table.bigInteger("attempts").notNullable();
      table.text("leaseOwner");
      table.bigInteger("leaseExpiresAt");
      table.bigInteger("createdAt").notNullable();
      table.bigInteger("updatedAt").notNullable();
    });
  }
  if (!(await trx.schema.hasTable("o_billing_audit_log"))) {
    await trx.schema.createTable("o_billing_audit_log", (table) => {
      table.text("id").notNullable().primary();
      table.text("workspaceId").notNullable();
      table.text("requestId").notNullable();
      table.text("action").notNullable();
      table.bigInteger("actorUserId").notNullable();
      table.text("actorRole").notNullable();
      table.bigInteger("authorizationRevision").notNullable();
      table.text("authMethod").notNullable();
      table.text("scope").notNullable();
      table.text("proofRecordId").notNullable();
      table.text("requestFingerprint").notNullable();
      table.text("resourceFingerprint").notNullable();
      table.text("evidenceId");
      table.text("idempotencyKey").notNullable();
      table.text("previousState");
      table.text("newState").notNullable();
      table.text("metadata").notNullable();
      table.bigInteger("createdAt").notNullable();
    });
  }
  if (!(await trx.schema.hasTable("o_billing_watchdog_lease"))) {
    await trx.schema.createTable("o_billing_watchdog_lease", (table) => {
      table.text("id").notNullable().primary();
      table.text("requestId").notNullable();
      table.text("workerId").notNullable();
      table.text("credentialRecordId").notNullable();
      table.bigInteger("acquiredAt").notNullable();
      table.bigInteger("expiresAt").notNullable();
      table.bigInteger("revision").notNullable();
      table.bigInteger("updatedAt").notNullable();
    });
  }
  if (!(await trx.schema.hasTable("o_billing_finance_worker"))) {
    await trx.schema.createTable("o_billing_finance_worker", (table) => {
      table.text("id").notNullable().primary();
      table.text("workerId").notNullable();
      table.text("bindingVersion").notNullable();
      table.text("status").notNullable();
      table.bigInteger("expiresAt").notNullable();
      table.bigInteger("revokedAt");
    });
  }
}

async function createExactIndexes(trx: Knex.Transaction): Promise<void> {
  const indexes = [
    ...SERVICE_REQUEST_V1_RUNTIME_INDEXES,
    {
      name: "uq_billing_service_request_submission_idempotency",
      table: REQUEST_TABLE,
      unique: true,
      columns: ["submittedByUserId", "submissionIdempotencyKey"],
      predicate: null,
    },
  ] as const;
  for (const index of indexes) {
    const unique = index.unique ? "UNIQUE " : "";
    const columns = index.columns.map(quoteSqlIdentifier).join(", ");
    const predicate = index.predicate ? ` WHERE ${index.predicate}` : "";
    await trx.raw(
      `CREATE ${unique}INDEX IF NOT EXISTS ${quoteSqlIdentifier(index.name)}
       ON ${quoteSqlIdentifier(index.table)} (${columns})${predicate}`,
    );
  }
}

async function createPostgresChecks(trx: Knex.Transaction): Promise<void> {
  if (!isPostgresClient(trx)) return;
  for (const constraint of SERVICE_REQUEST_V1_RUNTIME_CHECKS) {
    await trx.raw(
      `ALTER TABLE ${quoteSqlIdentifier(constraint.table)}
       DROP CONSTRAINT IF EXISTS ${quoteSqlIdentifier(constraint.name)}`,
    );
    await trx.raw(
      `ALTER TABLE ${quoteSqlIdentifier(constraint.table)}
       ADD CONSTRAINT ${quoteSqlIdentifier(constraint.name)}
       ${constraint.definition}`,
    );
  }
}

export async function upServiceRequestV1Runtime(
  trx: Knex.Transaction,
): Promise<void> {
  // Knex transactions use one PostgreSQL connection; keep catalog probes
  // sequential instead of issuing overlapping queries on that connection.
  await requireTable(trx, "o_user");
  await requireTable(trx, "o_auth_token");
  await requireTable(trx, REQUEST_TABLE);

  if (!(await trx.schema.hasColumn("o_user", "authorizationRevision"))) {
    await trx.schema.alterTable("o_user", (table) => {
      table.bigInteger("authorizationRevision").notNullable().defaultTo(1);
    });
  }
  await addColumn(trx, "o_auth_token", "revokedAt", "bigInteger");
  for (const [column, type] of Object.entries(requestColumns)) {
    await addColumn(
      trx,
      REQUEST_TABLE,
      column,
      type as "text" | "bigInteger",
    );
  }

  // Existing rows predate the cryptographically bound submission contract.
  // Preserve them for read compatibility, but never upgrade them into native
  // finance authority.
  await trx(REQUEST_TABLE).whereNull("compatibilityStatus").update({
    compatibilityStatus: "legacy_unverified",
  });
  await trx(REQUEST_TABLE).whereNull("revision").update({ revision: 0 });

  await createRuntimeTables(trx);
  await createExactIndexes(trx);
  await createPostgresChecks(trx);
}

export async function downServiceRequestV1Runtime(): Promise<never> {
  throw new Error(
    "Migration service_request_v1_runtime is forward-only and cannot be rolled back safely.",
  );
}
