import type { Knex } from "knex";

import { isPostgresClient } from "@/lib/dbDialect";

export const COMMERCIAL_CREDIT_LOT_TABLE = "o_commercial_credit_lot";
export const TENANT_SETTLEMENT_ACCOUNT_TABLE = "o_tenant_settlement_account";
export const TENANT_SETTLEMENT_LEDGER_TABLE = "o_tenant_settlement_ledger";
export const TENANT_AUTH_TRANSFER_TABLE = "o_tenant_auth_transfer";

const API_KEY_TABLE = "o_api_key";
const BILLING_SERVICE_REQUEST_TABLE = "o_billing_service_request";

export const COMMERCIAL_TENANT_RUNTIME_INDEXES = Object.freeze({
  billingServiceRequestTenantTime: "idx_o_billing_service_request_tenant_time",
  creditLotIdempotency: "uq_o_commercial_credit_lot_idempotency",
  creditLotUserStatusTime: "idx_o_commercial_credit_lot_user_status_time",
  creditLotTenantTime: "idx_o_commercial_credit_lot_tenant_time",
  creditLotWalletLedger: "idx_o_commercial_credit_lot_wallet_ledger",
  settlementLedgerIdempotency: "uq_o_tenant_settlement_ledger_idempotency",
  settlementLedgerTenantTime: "idx_o_tenant_settlement_ledger_tenant_time",
  settlementLedgerLot: "idx_o_tenant_settlement_ledger_lot",
  authTransferCodeHash: "uq_o_tenant_auth_transfer_code_hash",
  authTransferExpiry: "idx_o_tenant_auth_transfer_expiry",
  authTransferUserTime: "idx_o_tenant_auth_transfer_user_time",
});

type CanonicalColumnType = "text" | "bigint";

const TABLE_COLUMN_TYPES: Readonly<Record<string, Readonly<Record<string, CanonicalColumnType>>>> =
  Object.freeze({
    [COMMERCIAL_CREDIT_LOT_TABLE]: Object.freeze({
      id: "text",
      userId: "bigint",
      sellerTenantId: "text",
      accountWalletLedgerId: "text",
      sourceType: "text",
      sourceId: "text",
      amountMicros: "bigint",
      remainingMicros: "bigint",
      reservedMicros: "bigint",
      currency: "text",
      retailAmountMicros: "bigint",
      wholesaleAmountMicros: "bigint",
      wholesaleRatePpm: "bigint",
      status: "text",
      idempotencyKey: "text",
      metadata: "text",
      createdAt: "bigint",
      updatedAt: "bigint",
    }),
    [TENANT_SETTLEMENT_ACCOUNT_TABLE]: Object.freeze({
      tenantId: "text",
      balanceMicros: "bigint",
      currency: "text",
      status: "text",
      metadata: "text",
      createdAt: "bigint",
      updatedAt: "bigint",
    }),
    [TENANT_SETTLEMENT_LEDGER_TABLE]: Object.freeze({
      id: "text",
      tenantId: "text",
      type: "text",
      direction: "text",
      amountMicros: "bigint",
      currency: "text",
      balanceBeforeMicros: "bigint",
      balanceAfterMicros: "bigint",
      creditLotId: "text",
      sourceType: "text",
      sourceId: "text",
      idempotencyKey: "text",
      description: "text",
      metadata: "text",
      operatorUserId: "bigint",
      createdAt: "bigint",
      updatedAt: "bigint",
    }),
    [TENANT_AUTH_TRANSFER_TABLE]: Object.freeze({
      id: "text",
      codeHash: "text",
      userId: "bigint",
      sourceTenantId: "text",
      targetTenantId: "text",
      targetOrigin: "text",
      redirectPath: "text",
      expiresAt: "bigint",
      usedAt: "bigint",
      createdAt: "bigint",
    }),
  });

const NULLABLE_COLUMNS = new Set([
  `${COMMERCIAL_CREDIT_LOT_TABLE}.sourceId`,
  `${TENANT_SETTLEMENT_LEDGER_TABLE}.creditLotId`,
  `${TENANT_SETTLEMENT_LEDGER_TABLE}.sourceType`,
  `${TENANT_SETTLEMENT_LEDGER_TABLE}.sourceId`,
  `${TENANT_SETTLEMENT_LEDGER_TABLE}.description`,
  `${TENANT_SETTLEMENT_LEDGER_TABLE}.operatorUserId`,
  `${TENANT_AUTH_TRANSFER_TABLE}.usedAt`,
]);

const COLUMN_DEFAULTS: Readonly<Record<string, Readonly<Record<string, string>>>> =
  Object.freeze({
    [COMMERCIAL_CREDIT_LOT_TABLE]: Object.freeze({
      amountMicros: "0",
      remainingMicros: "0",
      reservedMicros: "0",
      currency: "GU",
      retailAmountMicros: "0",
      wholesaleAmountMicros: "0",
      wholesaleRatePpm: "1000000",
      status: "active",
      metadata: "{}",
    }),
    [TENANT_SETTLEMENT_ACCOUNT_TABLE]: Object.freeze({
      balanceMicros: "0",
      currency: "CNY",
      status: "active",
      metadata: "{}",
    }),
    [TENANT_SETTLEMENT_LEDGER_TABLE]: Object.freeze({
      amountMicros: "0",
      currency: "CNY",
      balanceBeforeMicros: "0",
      balanceAfterMicros: "0",
      metadata: "{}",
    }),
    [TENANT_AUTH_TRANSFER_TABLE]: Object.freeze({
      redirectPath: "/",
    }),
  });

const TABLE_FACTS = Object.entries(TABLE_COLUMN_TYPES).flatMap(([tableName, columns]) => [
  `table:${tableName}`,
  ...Object.entries(columns).flatMap(([columnName, columnType]) => {
    const facts = [
      `column:${tableName}.${columnName}`,
      `type:${tableName}.${columnName}.${columnType}`,
    ];
    if (!NULLABLE_COLUMNS.has(`${tableName}.${columnName}`)) {
      facts.push(`not-null:${tableName}.${columnName}`);
    }
    return facts;
  }),
]);

/**
 * Schema 40 was recorded before the mutable v1 bootstrap acquired this
 * multi-tenant bundle. These facts make the forward repair part of the
 * immutable migration catalog instead of trusting the current bootstrap.
 */
export const COMMERCIAL_TENANT_RUNTIME_REPAIR_REQUIRED_CONSTRAINTS = [
  `table:${API_KEY_TABLE}`,
  `column:${API_KEY_TABLE}.quotaUnit`,
  `type:${API_KEY_TABLE}.quotaUnit.text`,
  `not-null:${API_KEY_TABLE}.quotaUnit`,
  `table:${BILLING_SERVICE_REQUEST_TABLE}`,
  `column:${BILLING_SERVICE_REQUEST_TABLE}.sellerTenantId`,
  `type:${BILLING_SERVICE_REQUEST_TABLE}.sellerTenantId.text`,
  `not-null:${BILLING_SERVICE_REQUEST_TABLE}.sellerTenantId`,
  ...TABLE_FACTS,
  `primary-key:${COMMERCIAL_CREDIT_LOT_TABLE}.id`,
  `primary-key:${TENANT_SETTLEMENT_ACCOUNT_TABLE}.tenantId`,
  `primary-key:${TENANT_SETTLEMENT_LEDGER_TABLE}.id`,
  `primary-key:${TENANT_AUTH_TRANSFER_TABLE}.id`,
  `index:${BILLING_SERVICE_REQUEST_TABLE}.${COMMERCIAL_TENANT_RUNTIME_INDEXES.billingServiceRequestTenantTime}`,
  `index:${COMMERCIAL_CREDIT_LOT_TABLE}.${COMMERCIAL_TENANT_RUNTIME_INDEXES.creditLotIdempotency}`,
  `index:${COMMERCIAL_CREDIT_LOT_TABLE}.${COMMERCIAL_TENANT_RUNTIME_INDEXES.creditLotUserStatusTime}`,
  `index:${COMMERCIAL_CREDIT_LOT_TABLE}.${COMMERCIAL_TENANT_RUNTIME_INDEXES.creditLotTenantTime}`,
  `index:${COMMERCIAL_CREDIT_LOT_TABLE}.${COMMERCIAL_TENANT_RUNTIME_INDEXES.creditLotWalletLedger}`,
  `index:${TENANT_SETTLEMENT_LEDGER_TABLE}.${COMMERCIAL_TENANT_RUNTIME_INDEXES.settlementLedgerIdempotency}`,
  `index:${TENANT_SETTLEMENT_LEDGER_TABLE}.${COMMERCIAL_TENANT_RUNTIME_INDEXES.settlementLedgerTenantTime}`,
  `index:${TENANT_SETTLEMENT_LEDGER_TABLE}.${COMMERCIAL_TENANT_RUNTIME_INDEXES.settlementLedgerLot}`,
  `index:${TENANT_AUTH_TRANSFER_TABLE}.${COMMERCIAL_TENANT_RUNTIME_INDEXES.authTransferCodeHash}`,
  `index:${TENANT_AUTH_TRANSFER_TABLE}.${COMMERCIAL_TENANT_RUNTIME_INDEXES.authTransferExpiry}`,
  `index:${TENANT_AUTH_TRANSFER_TABLE}.${COMMERCIAL_TENANT_RUNTIME_INDEXES.authTransferUserTime}`,
  `unique-column:${COMMERCIAL_CREDIT_LOT_TABLE}.idempotencyKey`,
  `unique-tuple:${COMMERCIAL_CREDIT_LOT_TABLE}.idempotencyKey`,
  `unique-tuple:${TENANT_SETTLEMENT_LEDGER_TABLE}.tenantId.idempotencyKey`,
  `unique-column:${TENANT_AUTH_TRANSFER_TABLE}.codeHash`,
  `unique-tuple:${TENANT_AUTH_TRANSFER_TABLE}.codeHash`,
] as const;

function normalizedColumnDefault(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let normalized = String(value).trim();
  while (normalized.startsWith("(") && normalized.endsWith(")")) {
    normalized = normalized.slice(1, -1).trim();
  }
  normalized = normalized.replace(/::(?:text|bigint|integer)$/u, "");
  if (normalized.startsWith("'") && normalized.endsWith("'")) {
    normalized = normalized.slice(1, -1).replace(/''/gu, "'");
  }
  return normalized;
}

async function readColumnShape(
  trx: Knex.Transaction,
  tableName: string,
  columnName: string,
): Promise<{ defaultValue: string | null; notNull: boolean; type: string } | null> {
  const result = isPostgresClient(trx)
    ? await trx.raw(
      `SELECT column_default AS default_value,
              is_nullable,
              data_type
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ?
          AND column_name = ?`,
      [tableName, columnName],
    )
    : await trx.raw(
      `SELECT dflt_value AS default_value,
              "notnull" AS not_null,
              type AS data_type
         FROM pragma_table_info(?)
        WHERE name = ?`,
      [tableName, columnName],
    );
  const row = databaseRows(result)[0];
  if (!row) return null;
  return {
    defaultValue: normalizedColumnDefault(row.default_value),
    notNull: isPostgresClient(trx)
      ? String(row.is_nullable) === "NO"
      : Number(row.not_null) === 1,
    type: String(row.data_type || "").trim().toLowerCase(),
  };
}

async function ensureRequiredExistingColumn(
  trx: Knex.Transaction,
  tableName: string,
  columnName: string,
  defaultValue: string,
): Promise<void> {
  if (!(await trx.schema.hasTable(tableName))) {
    throw new Error(
      `Migration portrait_asset_review_runtime requires historical table ${tableName}`,
    );
  }
  const before = await readColumnShape(trx, tableName, columnName);
  if (!before) {
    await trx.schema.alterTable(tableName, (table) => {
      table.text(columnName).notNullable().defaultTo(defaultValue);
    });
  } else {
    if (before.type !== "text") {
      throw new Error(
        `Migration portrait_asset_review_runtime found incompatible type for ${tableName}.${columnName}`,
      );
    }
    if (before.notNull && before.defaultValue === defaultValue) return;
    await trx(tableName).whereNull(columnName).update({ [columnName]: defaultValue });
    await trx.schema.alterTable(tableName, (table) => {
      table.text(columnName).notNullable().defaultTo(defaultValue).alter();
    });
  }
  const after = await readColumnShape(trx, tableName, columnName);
  if (
    !after
    || after.type !== "text"
    || !after.notNull
    || after.defaultValue !== defaultValue
  ) {
    throw new Error(
      `Migration portrait_asset_review_runtime could not normalize ${tableName}.${columnName}`,
    );
  }
}

async function assertCompleteExistingTable(
  trx: Knex.Transaction,
  tableName: string,
): Promise<boolean> {
  if (!(await trx.schema.hasTable(tableName))) return false;
  const expectedColumns = Object.keys(TABLE_COLUMN_TYPES[tableName] || {});
  const result = isPostgresClient(trx)
    ? await trx.raw(
      `SELECT column_name AS name, column_default AS default_value
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ?
        ORDER BY ordinal_position`,
      [tableName],
    )
    : await trx.raw(
      `SELECT name, dflt_value AS default_value
         FROM pragma_table_info(?)
        ORDER BY cid`,
      [tableName],
    );
  const rows = Array.isArray(result)
    ? result as Array<Record<string, unknown>>
    : ((result as { rows?: Array<Record<string, unknown>> }).rows || []);
  const actualColumns = rows.map((row) => String(row.name));
  const missing = expectedColumns.filter((columnName) => !actualColumns.includes(columnName));
  const unexpected = actualColumns.filter((columnName) => !expectedColumns.includes(columnName));
  if (missing.length || unexpected.length) {
    throw new Error(
      `Migration portrait_asset_review_runtime found partial historical table ${tableName}; missing ${missing.join(",")}; unexpected ${unexpected.join(",")}`,
    );
  }
  const expectedDefaults = COLUMN_DEFAULTS[tableName] || {};
  for (const row of rows) {
    const columnName = String(row.name);
    const actualDefault = normalizedColumnDefault(row.default_value);
    const expectedDefault = Object.hasOwn(expectedDefaults, columnName)
      ? expectedDefaults[columnName]
      : null;
    if (actualDefault !== expectedDefault) {
      throw new Error(
        `Migration portrait_asset_review_runtime found incompatible default for ${tableName}.${columnName}`,
      );
    }
  }
  return true;
}

async function createCommercialCreditLotTable(trx: Knex.Transaction): Promise<void> {
  if (await assertCompleteExistingTable(trx, COMMERCIAL_CREDIT_LOT_TABLE)) return;
  await trx.schema.createTable(COMMERCIAL_CREDIT_LOT_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.bigInteger("userId").notNullable();
    table.text("sellerTenantId").notNullable();
    table.text("accountWalletLedgerId").notNullable();
    table.text("sourceType").notNullable();
    table.text("sourceId");
    table.bigInteger("amountMicros").notNullable().defaultTo(0);
    table.bigInteger("remainingMicros").notNullable().defaultTo(0);
    table.bigInteger("reservedMicros").notNullable().defaultTo(0);
    table.text("currency").notNullable().defaultTo("GU");
    table.bigInteger("retailAmountMicros").notNullable().defaultTo(0);
    table.bigInteger("wholesaleAmountMicros").notNullable().defaultTo(0);
    table.bigInteger("wholesaleRatePpm").notNullable().defaultTo(1_000_000);
    table.text("status").notNullable().defaultTo("active");
    table.text("idempotencyKey").notNullable();
    table.text("metadata").notNullable().defaultTo("{}");
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();
  });
}

async function createTenantSettlementAccountTable(trx: Knex.Transaction): Promise<void> {
  if (await assertCompleteExistingTable(trx, TENANT_SETTLEMENT_ACCOUNT_TABLE)) return;
  await trx.schema.createTable(TENANT_SETTLEMENT_ACCOUNT_TABLE, (table) => {
    table.text("tenantId").notNullable().primary();
    table.bigInteger("balanceMicros").notNullable().defaultTo(0);
    table.text("currency").notNullable().defaultTo("CNY");
    table.text("status").notNullable().defaultTo("active");
    table.text("metadata").notNullable().defaultTo("{}");
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();
  });
}

async function createTenantSettlementLedgerTable(trx: Knex.Transaction): Promise<void> {
  if (await assertCompleteExistingTable(trx, TENANT_SETTLEMENT_LEDGER_TABLE)) return;
  await trx.schema.createTable(TENANT_SETTLEMENT_LEDGER_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("tenantId").notNullable();
    table.text("type").notNullable();
    table.text("direction").notNullable();
    table.bigInteger("amountMicros").notNullable().defaultTo(0);
    table.text("currency").notNullable().defaultTo("CNY");
    table.bigInteger("balanceBeforeMicros").notNullable().defaultTo(0);
    table.bigInteger("balanceAfterMicros").notNullable().defaultTo(0);
    table.text("creditLotId");
    table.text("sourceType");
    table.text("sourceId");
    table.text("idempotencyKey").notNullable();
    table.text("description");
    table.text("metadata").notNullable().defaultTo("{}");
    table.bigInteger("operatorUserId");
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();
  });
}

async function createTenantAuthTransferTable(trx: Knex.Transaction): Promise<void> {
  if (await assertCompleteExistingTable(trx, TENANT_AUTH_TRANSFER_TABLE)) return;
  await trx.schema.createTable(TENANT_AUTH_TRANSFER_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("codeHash").notNullable();
    table.bigInteger("userId").notNullable();
    table.text("sourceTenantId").notNullable();
    table.text("targetTenantId").notNullable();
    table.text("targetOrigin").notNullable();
    table.text("redirectPath").notNullable().defaultTo("/");
    table.bigInteger("expiresAt").notNullable();
    table.bigInteger("usedAt");
    table.bigInteger("createdAt").notNullable();
  });
}

interface RequiredIndex {
  name: string;
  tableName: string;
  columns: readonly string[];
  unique?: boolean;
}

function databaseRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  return (result as { rows?: Array<Record<string, unknown>> })?.rows || [];
}

function databaseBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "t";
}

async function readNamedIndex(
  trx: Knex.Transaction,
  input: RequiredIndex,
): Promise<{ columns: string[]; unique: boolean; exactShape: boolean } | null> {
  if (isPostgresClient(trx)) {
    const rows = databaseRows(await trx.raw(
      `SELECT index_entry.indisunique AS is_unique,
              index_entry.indisvalid AS is_valid,
              index_entry.indisready AS is_ready,
              index_entry.indpred IS NULL AS unfiltered,
              index_entry.indexprs IS NULL AS plain,
              index_entry.indnatts = index_entry.indnkeyatts AS no_include,
              access_method.amname AS access_method,
              array_agg(attribute_entry.attname ORDER BY key_entry.ordinality) AS columns
         FROM pg_catalog.pg_class AS table_entry
         JOIN pg_catalog.pg_namespace AS namespace_entry
           ON namespace_entry.oid = table_entry.relnamespace
         JOIN pg_catalog.pg_index AS index_entry
           ON index_entry.indrelid = table_entry.oid
         JOIN pg_catalog.pg_class AS named_index
           ON named_index.oid = index_entry.indexrelid
         JOIN pg_catalog.pg_am AS access_method
           ON access_method.oid = named_index.relam
         JOIN LATERAL unnest(index_entry.indkey) WITH ORDINALITY
           AS key_entry(attnum, ordinality)
           ON key_entry.ordinality <= index_entry.indnkeyatts
         JOIN pg_catalog.pg_attribute AS attribute_entry
           ON attribute_entry.attrelid = table_entry.oid
          AND attribute_entry.attnum = key_entry.attnum
        WHERE namespace_entry.nspname = current_schema()
          AND table_entry.relname = ?
          AND named_index.relname = ?
        GROUP BY index_entry.indisunique,
                 index_entry.indisvalid,
                 index_entry.indisready,
                 (index_entry.indpred IS NULL),
                 (index_entry.indexprs IS NULL),
                 (index_entry.indnatts = index_entry.indnkeyatts),
                 access_method.amname`,
      [input.tableName, input.name],
    ));
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      columns: Array.isArray(row.columns)
        ? row.columns.map(String)
        : String(row.columns || "").replace(/^\{|\}$/gu, "").split(",").filter(Boolean),
      unique: databaseBoolean(row.is_unique),
      exactShape: databaseBoolean(row.is_valid)
        && databaseBoolean(row.is_ready)
        && databaseBoolean(row.unfiltered)
        && databaseBoolean(row.plain)
        && databaseBoolean(row.no_include)
        && String(row.access_method) === "btree",
    };
  }

  const rows = databaseRows(await trx.raw(
    `SELECT name, "unique" AS is_unique, partial
       FROM pragma_index_list(?)
      WHERE name = ?`,
    [input.tableName, input.name],
  ));
  if (rows.length === 0) return null;
  const columns = databaseRows(await trx.raw(
    `SELECT name FROM pragma_index_info(?) ORDER BY seqno`,
    [input.name],
  )).map((row) => String(row.name));
  return {
    columns,
    unique: databaseBoolean(rows[0].is_unique),
    exactShape: !databaseBoolean(rows[0].partial),
  };
}

function assertIndexShape(
  actual: { columns: string[]; unique: boolean; exactShape: boolean },
  expected: RequiredIndex,
): void {
  if (
    !actual.exactShape
    || actual.unique !== Boolean(expected.unique)
    || actual.columns.length !== expected.columns.length
    || actual.columns.some((column, index) => column !== expected.columns[index])
  ) {
    throw new Error(
      `Migration portrait_asset_review_runtime found incompatible named index ${expected.name}`,
    );
  }
}

async function ensureExactIndex(
  trx: Knex.Transaction,
  input: RequiredIndex,
): Promise<void> {
  const existing = await readNamedIndex(trx, input);
  if (existing) {
    assertIndexShape(existing, input);
    return;
  }
  const columnBindings = input.columns.map(() => "??").join(", ");
  await trx.raw(
    `CREATE ${input.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ?? ON ?? (${columnBindings})`,
    [input.name, input.tableName, ...input.columns],
  );
  const created = await readNamedIndex(trx, input);
  if (!created) {
    throw new Error(
      `Migration portrait_asset_review_runtime could not verify named index ${input.name}`,
    );
  }
  assertIndexShape(created, input);
}

/** Repair the exact mutable-baseline delta missing from the deployed schema 40. */
export async function upCommercialTenantRuntimeRepair(
  trx: Knex.Transaction,
): Promise<void> {
  const bundleTables = [
    COMMERCIAL_CREDIT_LOT_TABLE,
    TENANT_SETTLEMENT_ACCOUNT_TABLE,
    TENANT_SETTLEMENT_LEDGER_TABLE,
    TENANT_AUTH_TRANSFER_TABLE,
  ] as const;
  const bundleStates = await Promise.all(
    bundleTables.map((tableName) => trx.schema.hasTable(tableName)),
  );
  if (bundleStates.some(Boolean) && !bundleStates.every(Boolean)) {
    const missing = bundleTables.filter((_, index) => !bundleStates[index]);
    throw new Error(
      `Migration portrait_asset_review_runtime found a partial commercial tenant bundle; missing ${missing.join(",")}`,
    );
  }

  await ensureRequiredExistingColumn(trx, API_KEY_TABLE, "quotaUnit", "request");
  await ensureRequiredExistingColumn(
    trx,
    BILLING_SERVICE_REQUEST_TABLE,
    "sellerTenantId",
    "FANJIN",
  );

  await createCommercialCreditLotTable(trx);
  await createTenantSettlementAccountTable(trx);
  await createTenantSettlementLedgerTable(trx);
  await createTenantAuthTransferTable(trx);

  const indexes = COMMERCIAL_TENANT_RUNTIME_INDEXES;
  await ensureExactIndex(trx, {
    name: indexes.billingServiceRequestTenantTime,
    tableName: BILLING_SERVICE_REQUEST_TABLE,
    columns: ["sellerTenantId", "createdAt"],
  });
  await ensureExactIndex(trx, {
    name: indexes.creditLotIdempotency,
    tableName: COMMERCIAL_CREDIT_LOT_TABLE,
    columns: ["idempotencyKey"],
    unique: true,
  });
  await ensureExactIndex(trx, {
    name: indexes.creditLotUserStatusTime,
    tableName: COMMERCIAL_CREDIT_LOT_TABLE,
    columns: ["userId", "status", "createdAt"],
  });
  await ensureExactIndex(trx, {
    name: indexes.creditLotTenantTime,
    tableName: COMMERCIAL_CREDIT_LOT_TABLE,
    columns: ["sellerTenantId", "createdAt"],
  });
  await ensureExactIndex(trx, {
    name: indexes.creditLotWalletLedger,
    tableName: COMMERCIAL_CREDIT_LOT_TABLE,
    columns: ["accountWalletLedgerId"],
  });
  await ensureExactIndex(trx, {
    name: indexes.settlementLedgerIdempotency,
    tableName: TENANT_SETTLEMENT_LEDGER_TABLE,
    columns: ["tenantId", "idempotencyKey"],
    unique: true,
  });
  await ensureExactIndex(trx, {
    name: indexes.settlementLedgerTenantTime,
    tableName: TENANT_SETTLEMENT_LEDGER_TABLE,
    columns: ["tenantId", "createdAt"],
  });
  await ensureExactIndex(trx, {
    name: indexes.settlementLedgerLot,
    tableName: TENANT_SETTLEMENT_LEDGER_TABLE,
    columns: ["creditLotId"],
  });
  await ensureExactIndex(trx, {
    name: indexes.authTransferCodeHash,
    tableName: TENANT_AUTH_TRANSFER_TABLE,
    columns: ["codeHash"],
    unique: true,
  });
  await ensureExactIndex(trx, {
    name: indexes.authTransferExpiry,
    tableName: TENANT_AUTH_TRANSFER_TABLE,
    columns: ["expiresAt"],
  });
  await ensureExactIndex(trx, {
    name: indexes.authTransferUserTime,
    tableName: TENANT_AUTH_TRANSFER_TABLE,
    columns: ["userId", "createdAt"],
  });
}
