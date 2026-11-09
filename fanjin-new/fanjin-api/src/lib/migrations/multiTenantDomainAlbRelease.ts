import type { Knex } from "knex";

import { isPostgresClient } from "@/lib/dbDialect";

/**
 * Schema 51 — Fanjin 0.1.4 multi-tenant domain, certificate, ALB release,
 * user attribution, consumption settlement and publisher linkage storage.
 *
 * This migration is the only authoritative path that upgrades a schema-50
 * database to the 0.1.4 shape. The mutable v1 bootstrap (fixDB) no longer
 * creates any of these structures so that a fresh database and an upgraded
 * database converge on exactly the DDL emitted here.
 *
 * Immutability contract: never edit this file after a production database
 * records version 51. Append schema 52 instead.
 */

export const USER_TENANT_ATTRIBUTION_HISTORY_TABLE = "o_user_tenant_attribution_history";
export const COMMERCIAL_CONSUMPTION_ALLOCATION_TABLE = "o_commercial_consumption_allocation";
export const PROVIDER_COST_LEDGER_TABLE = "o_provider_cost_ledger";
export const TENANT_SETTLEMENT_PERIOD_TABLE = "o_tenant_settlement_period";
export const COMMERCIAL_TENANT_TABLE = "o_commercial_tenant";
export const TENANT_DOMAIN_TABLE = "o_tenant_domain";
export const DOMAIN_VERIFICATION_TABLE = "o_domain_verification";
export const TENANT_CERTIFICATE_TABLE = "o_tenant_certificate";
export const INGRESS_CLUSTER_TABLE = "o_ingress_cluster";
export const TENANT_INGRESS_BINDING_TABLE = "o_tenant_ingress_binding";
export const TENANT_DOMAIN_OPERATION_TABLE = "o_tenant_domain_operation";

const USER_COMMERCIAL_PROFILE_TABLE = "o_user_commercial_profile";
const COMMERCIAL_CREDIT_LOT_TABLE = "o_commercial_credit_lot";
const PAYMENT_ORDER_TABLE = "o_payment_order";

/** Deterministic backfill tenant for legacy attribution rows. */
const LEGACY_DEFAULT_TENANT_ID = "FANJIN";
const LEGACY_REGISTRATION_SOURCE = "legacy_default";

export const MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES = Object.freeze({
  profileOwnerTenant: "idx_o_user_commercial_profile_owner_tenant",
  profileRegisteredTenant: "idx_o_user_commercial_profile_registered_tenant",
  attributionHistoryUserTime: "idx_o_user_tenant_attribution_history_user_time",
  allocationIdempotency: "uq_o_commercial_consumption_allocation_idem",
  allocationUserTime: "idx_o_consumption_allocation_user_time",
  allocationCollectorTime: "idx_o_consumption_allocation_collector_time",
  allocationOwnerTime: "idx_o_consumption_allocation_owner_time",
  providerCostUsageProvider: "idx_o_provider_cost_ledger_usage_provider",
  providerCostPeriod: "idx_o_provider_cost_ledger_period",
  providerCostState: "idx_o_provider_cost_ledger_state",
  settlementPeriodKey: "uq_o_tenant_settlement_period_key",
  commercialTenantStatus: "idx_o_commercial_tenant_status",
  tenantDomainHostname: "idx_o_tenant_domain_hostname",
  tenantDomainTenantState: "idx_o_tenant_domain_tenant_state",
  tenantDomainState: "idx_o_tenant_domain_state",
  domainVerificationDomainState: "idx_o_domain_verification_domain_state",
  tenantCertificateTenantStatus: "idx_o_tenant_certificate_tenant_status",
  tenantCertificateNotAfter: "idx_o_tenant_certificate_not_after",
  tenantIngressBindingDomain: "uq_o_tenant_ingress_binding_domain",
  tenantDomainOperationIdempotency: "uq_o_tenant_domain_operation_idem",
  tenantDomainOperationDomainState: "idx_o_tenant_domain_operation_domain_state",
  creditLotCollectorTime: "idx_o_commercial_credit_lot_collector_time",
  paymentOrderCollectorTime: "idx_o_payment_order_collector_time",
});

type CanonicalColumnType = "text" | "bigint" | "boolean";

interface ColumnSpec {
  type: CanonicalColumnType;
  nullable: boolean;
  default?: string | number | boolean;
}

type ColumnSpecs = Readonly<Record<string, ColumnSpec>>;

interface TableSpec {
  columns: ColumnSpecs;
  primaryKey: readonly string[];
  /** Named unique constraints declared inline by the createTable builder. */
  uniqueIndexes: readonly {
    name: string;
    columns: readonly string[];
  }[];
  /** Auto-named (knex) non-unique indexes declared inline by the builder. */
  inlineIndexes: readonly (readonly string[])[];
}

const NOT_NULL_TEXT: ColumnSpec = { type: "text", nullable: false };
const NULLABLE_TEXT: ColumnSpec = { type: "text", nullable: true };
const NOT_NULL_BIGINT: ColumnSpec = { type: "bigint", nullable: false };
const NULLABLE_BIGINT: ColumnSpec = { type: "bigint", nullable: true };

function notNullText(defaultValue?: string): ColumnSpec {
  return { type: "text", nullable: false, ...(defaultValue === undefined ? {} : { default: defaultValue }) };
}

function notNullBigInt(defaultValue?: number): ColumnSpec {
  return { type: "bigint", nullable: false, ...(defaultValue === undefined ? {} : { default: defaultValue }) };
}

function notNullBoolean(defaultValue: boolean): ColumnSpec {
  return { type: "boolean", nullable: false, default: defaultValue };
}

const TABLE_SPECS: Readonly<Record<string, TableSpec>> = Object.freeze({
  [USER_TENANT_ATTRIBUTION_HISTORY_TABLE]: Object.freeze({
    columns: Object.freeze({
      id: NOT_NULL_TEXT,
      userId: NOT_NULL_BIGINT,
      fromTenantId: NOT_NULL_TEXT,
      toTenantId: NOT_NULL_TEXT,
      revision: NOT_NULL_BIGINT,
      reason: NOT_NULL_TEXT,
      operatorUserId: NULLABLE_BIGINT,
      metadata: notNullText("{}"),
      createdAt: NOT_NULL_BIGINT,
    }),
    primaryKey: Object.freeze(["id"]),
    uniqueIndexes: Object.freeze([]),
    inlineIndexes: Object.freeze([Object.freeze(["userId", "createdAt"])]),
  }),
  [COMMERCIAL_CONSUMPTION_ALLOCATION_TABLE]: Object.freeze({
    columns: Object.freeze({
      id: NOT_NULL_TEXT,
      usageId: NULLABLE_TEXT,
      requestId: NULLABLE_TEXT,
      taskId: NULLABLE_TEXT,
      ledgerId: NULLABLE_TEXT,
      userId: NOT_NULL_BIGINT,
      workspaceId: NULLABLE_TEXT,
      spendSource: NOT_NULL_TEXT,
      creditLotId: NULLABLE_TEXT,
      collectorTenantId: NULLABLE_TEXT,
      registeredTenantIdSnapshot: NOT_NULL_TEXT,
      ownerTenantIdSnapshot: NOT_NULL_TEXT,
      chargedGuMicros: NOT_NULL_BIGINT,
      retailPortionMicros: notNullBigInt(0),
      wholesaleAccrualMicros: notNullBigInt(0),
      wholesaleRatePpm: notNullBigInt(0),
      pricingRuleId: NULLABLE_TEXT,
      pricingRuleRevision: NULLABLE_BIGINT,
      settlementMode: NOT_NULL_TEXT,
      capturedAt: NOT_NULL_BIGINT,
      sourceType: NULLABLE_TEXT,
      sourceId: NULLABLE_TEXT,
      idempotencyKey: NOT_NULL_TEXT,
      createdAt: NOT_NULL_BIGINT,
    }),
    primaryKey: Object.freeze(["id"]),
    uniqueIndexes: Object.freeze([
      Object.freeze({
        name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.allocationIdempotency,
        columns: Object.freeze(["idempotencyKey"]),
      }),
    ]),
    inlineIndexes: Object.freeze([
      Object.freeze(["userId", "capturedAt"]),
      Object.freeze(["collectorTenantId", "capturedAt"]),
      Object.freeze(["ownerTenantIdSnapshot", "capturedAt"]),
      Object.freeze(["creditLotId"]),
    ]),
  }),
  [PROVIDER_COST_LEDGER_TABLE]: Object.freeze({
    columns: Object.freeze({
      id: NOT_NULL_TEXT,
      usageId: NULLABLE_TEXT,
      requestId: NULLABLE_TEXT,
      provider: NOT_NULL_TEXT,
      channel: NULLABLE_TEXT,
      model: NULLABLE_TEXT,
      estimatedCostMicros: notNullBigInt(0),
      officialCostMicros: NULLABLE_BIGINT,
      currency: notNullText("CNY"),
      providerPriceRevision: NULLABLE_BIGINT,
      invoiceId: NULLABLE_TEXT,
      billingPeriod: NULLABLE_TEXT,
      state: notNullText("estimated"),
      differenceMicros: NULLABLE_BIGINT,
      metadata: notNullText("{}"),
      createdAt: NOT_NULL_BIGINT,
      updatedAt: NOT_NULL_BIGINT,
    }),
    primaryKey: Object.freeze(["id"]),
    uniqueIndexes: Object.freeze([]),
    inlineIndexes: Object.freeze([
      Object.freeze(["usageId", "provider"]),
      Object.freeze(["billingPeriod"]),
      Object.freeze(["state"]),
    ]),
  }),
  [TENANT_SETTLEMENT_PERIOD_TABLE]: Object.freeze({
    columns: Object.freeze({
      id: NOT_NULL_TEXT,
      periodKey: NOT_NULL_TEXT,
      status: notNullText("open"),
      preflightResult: NULLABLE_TEXT,
      settlementPolicyId: NULLABLE_TEXT,
      settlementPolicyRevision: NULLABLE_BIGINT,
      closedAt: NULLABLE_BIGINT,
      closedByUserId: NULLABLE_BIGINT,
      metadata: notNullText("{}"),
      createdAt: NOT_NULL_BIGINT,
      updatedAt: NOT_NULL_BIGINT,
    }),
    primaryKey: Object.freeze(["id"]),
    uniqueIndexes: Object.freeze([
      Object.freeze({
        name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.settlementPeriodKey,
        columns: Object.freeze(["periodKey"]),
      }),
    ]),
    inlineIndexes: Object.freeze([]),
  }),
  [COMMERCIAL_TENANT_TABLE]: Object.freeze({
    columns: Object.freeze({
      id: NOT_NULL_TEXT,
      name: NOT_NULL_TEXT,
      operatorName: NOT_NULL_TEXT,
      status: notNullText("draft"),
      defaultDomainId: NULLABLE_TEXT,
      rechargeEnabled: notNullBoolean(true),
      settlementRequired: notNullBoolean(true),
      wholesaleRatePpm: notNullBigInt(1_000_000),
      legalProfile: notNullText("{}"),
      configRevision: notNullBigInt(1),
      configurationSource: notNullText("deployment"),
      createdByUserId: NULLABLE_BIGINT,
      updatedByUserId: NULLABLE_BIGINT,
      createdAt: NOT_NULL_BIGINT,
      updatedAt: NOT_NULL_BIGINT,
      deletedAt: NULLABLE_BIGINT,
    }),
    primaryKey: Object.freeze(["id"]),
    uniqueIndexes: Object.freeze([]),
    inlineIndexes: Object.freeze([Object.freeze(["status"])]),
  }),
  [TENANT_DOMAIN_TABLE]: Object.freeze({
    columns: Object.freeze({
      id: NOT_NULL_TEXT,
      tenantId: NOT_NULL_TEXT,
      hostname: NOT_NULL_TEXT,
      displayHostname: NULLABLE_TEXT,
      purpose: notNullText("web_api"),
      isPrimary: notNullBoolean(false),
      lifecycleState: notNullText("draft"),
      ownershipState: notNullText("pending"),
      icpState: notNullText("unknown"),
      certificateId: NULLABLE_TEXT,
      ingressBindingId: NULLABLE_TEXT,
      desiredRevision: notNullBigInt(1),
      observedRevision: notNullBigInt(0),
      lastVerifiedAt: NULLABLE_BIGINT,
      nextVerifyAt: NULLABLE_BIGINT,
      activatedAt: NULLABLE_BIGINT,
      suspendedAt: NULLABLE_BIGINT,
      failureCode: NULLABLE_TEXT,
      failureMessage: NULLABLE_TEXT,
      metadata: notNullText("{}"),
      createdByUserId: NULLABLE_BIGINT,
      updatedByUserId: NULLABLE_BIGINT,
      createdAt: NOT_NULL_BIGINT,
      updatedAt: NOT_NULL_BIGINT,
      deletedAt: NULLABLE_BIGINT,
    }),
    primaryKey: Object.freeze(["id"]),
    uniqueIndexes: Object.freeze([]),
    inlineIndexes: Object.freeze([
      Object.freeze(["hostname"]),
      Object.freeze(["tenantId", "lifecycleState"]),
      Object.freeze(["lifecycleState"]),
    ]),
  }),
  [DOMAIN_VERIFICATION_TABLE]: Object.freeze({
    columns: Object.freeze({
      id: NOT_NULL_TEXT,
      domainId: NOT_NULL_TEXT,
      method: notNullText("dns_txt"),
      recordName: NOT_NULL_TEXT,
      recordType: notNullText("TXT"),
      tokenHash: NOT_NULL_TEXT,
      valueHint: NOT_NULL_TEXT,
      state: notNullText("pending"),
      expiresAt: NOT_NULL_BIGINT,
      attemptCount: notNullBigInt(0),
      lastAttemptAt: NULLABLE_BIGINT,
      verifiedDnsAnswers: notNullText("[]"),
      createdAt: NOT_NULL_BIGINT,
      updatedAt: NOT_NULL_BIGINT,
    }),
    primaryKey: Object.freeze(["id"]),
    uniqueIndexes: Object.freeze([]),
    inlineIndexes: Object.freeze([Object.freeze(["domainId", "state"])]),
  }),
  [TENANT_CERTIFICATE_TABLE]: Object.freeze({
    columns: Object.freeze({
      id: NOT_NULL_TEXT,
      tenantId: NOT_NULL_TEXT,
      source: NOT_NULL_TEXT,
      provider: NULLABLE_TEXT,
      providerCertificateId: NULLABLE_TEXT,
      commonName: NULLABLE_TEXT,
      sans: notNullText("[]"),
      fingerprintSha256: NULLABLE_TEXT,
      keyAlgorithm: NULLABLE_TEXT,
      keySize: NULLABLE_BIGINT,
      issuer: NULLABLE_TEXT,
      serialNumber: NULLABLE_TEXT,
      notBefore: NULLABLE_BIGINT,
      notAfter: NULLABLE_BIGINT,
      status: notNullText("pending"),
      renewalMode: notNullText("manual"),
      replacesCertificateId: NULLABLE_TEXT,
      lastCheckedAt: NULLABLE_BIGINT,
      failureCode: NULLABLE_TEXT,
      failureMessage: NULLABLE_TEXT,
      metadata: notNullText("{}"),
      createdByUserId: NULLABLE_BIGINT,
      updatedByUserId: NULLABLE_BIGINT,
      createdAt: NOT_NULL_BIGINT,
      updatedAt: NOT_NULL_BIGINT,
    }),
    primaryKey: Object.freeze(["id"]),
    uniqueIndexes: Object.freeze([]),
    inlineIndexes: Object.freeze([
      Object.freeze(["tenantId", "status"]),
      Object.freeze(["notAfter"]),
    ]),
  }),
  [INGRESS_CLUSTER_TABLE]: Object.freeze({
    columns: Object.freeze({
      id: NOT_NULL_TEXT,
      name: NOT_NULL_TEXT,
      environment: notNullText("production"),
      provider: notNullText("volcengine_alb"),
      region: notNullText("cn-beijing"),
      loadBalancerId: NULLABLE_TEXT,
      httpListenerId: NULLABLE_TEXT,
      httpsListenerId: NULLABLE_TEXT,
      defaultServerGroupId: NULLABLE_TEXT,
      edition: NULLABLE_TEXT,
      networkType: NULLABLE_TEXT,
      sniQuota: notNullBigInt(20),
      sniUsed: notNullBigInt(0),
      status: notNullText("provisioning"),
      credentialRef: NULLABLE_TEXT,
      metadata: notNullText("{}"),
      createdAt: NOT_NULL_BIGINT,
      updatedAt: NOT_NULL_BIGINT,
    }),
    primaryKey: Object.freeze(["id"]),
    uniqueIndexes: Object.freeze([]),
    inlineIndexes: Object.freeze([]),
  }),
  [TENANT_INGRESS_BINDING_TABLE]: Object.freeze({
    columns: Object.freeze({
      id: NOT_NULL_TEXT,
      domainId: NOT_NULL_TEXT,
      ingressClusterId: NOT_NULL_TEXT,
      certificateId: NULLABLE_TEXT,
      providerDomainExtensionId: NULLABLE_TEXT,
      providerRuleId: NULLABLE_TEXT,
      serverGroupId: NULLABLE_TEXT,
      desiredState: notNullText("bound"),
      observedState: notNullText("unbound"),
      lastReconciledAt: NULLABLE_BIGINT,
      metadata: notNullText("{}"),
      createdAt: NOT_NULL_BIGINT,
      updatedAt: NOT_NULL_BIGINT,
    }),
    primaryKey: Object.freeze(["id"]),
    uniqueIndexes: Object.freeze([
      Object.freeze({
        name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.tenantIngressBindingDomain,
        columns: Object.freeze(["domainId"]),
      }),
    ]),
    inlineIndexes: Object.freeze([]),
  }),
  [TENANT_DOMAIN_OPERATION_TABLE]: Object.freeze({
    columns: Object.freeze({
      id: NOT_NULL_TEXT,
      idempotencyKey: NOT_NULL_TEXT,
      tenantId: NOT_NULL_TEXT,
      domainId: NULLABLE_TEXT,
      operationType: NOT_NULL_TEXT,
      requestedRevision: NOT_NULL_BIGINT,
      state: notNullText("queued"),
      currentStep: NULLABLE_TEXT,
      attemptCount: notNullBigInt(0),
      nextAttemptAt: NULLABLE_BIGINT,
      requestedByUserId: NULLABLE_BIGINT,
      approvedByUserId: NULLABLE_BIGINT,
      result: NULLABLE_TEXT,
      errorCode: NULLABLE_TEXT,
      errorMessage: NULLABLE_TEXT,
      createdAt: NOT_NULL_BIGINT,
      startedAt: NULLABLE_BIGINT,
      finishedAt: NULLABLE_BIGINT,
      updatedAt: NOT_NULL_BIGINT,
    }),
    primaryKey: Object.freeze(["id"]),
    uniqueIndexes: Object.freeze([
      Object.freeze({
        name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.tenantDomainOperationIdempotency,
        columns: Object.freeze(["idempotencyKey"]),
      }),
    ]),
    inlineIndexes: Object.freeze([
      Object.freeze(["domainId", "state"]),
      Object.freeze(["tenantId", "createdAt"]),
    ]),
  }),
});

/** Additive columns installed on pre-existing schema-50 tables. */
const ALTERED_TABLE_COLUMNS: Readonly<Record<string, ColumnSpecs>> = Object.freeze({
  [USER_COMMERCIAL_PROFILE_TABLE]: Object.freeze({
    registeredTenantId: NULLABLE_TEXT,
    registrationHostname: NULLABLE_TEXT,
    registrationSource: NULLABLE_TEXT,
    ownerTenantId: NULLABLE_TEXT,
    ownerTenantRevision: notNullBigInt(1),
    ownerTenantChangedAt: NULLABLE_BIGINT,
    ownerTenantChangedByUserId: NULLABLE_BIGINT,
    ownerTenantChangeReason: NULLABLE_TEXT,
  }),
  [COMMERCIAL_CREDIT_LOT_TABLE]: Object.freeze({
    collectorTenantId: NULLABLE_TEXT,
  }),
  [PAYMENT_ORDER_TABLE]: Object.freeze({
    collectorTenantId: NULLABLE_TEXT,
    registeredTenantIdSnapshot: NULLABLE_TEXT,
    ownerTenantIdSnapshot: NULLABLE_TEXT,
  }),
});

interface RequiredIndex {
  name: string;
  tableName: string;
  columns: readonly string[];
  unique?: boolean;
}

const NAMED_INDEXES: readonly RequiredIndex[] = Object.freeze([
  Object.freeze({
    name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.profileOwnerTenant,
    tableName: USER_COMMERCIAL_PROFILE_TABLE,
    columns: Object.freeze(["ownerTenantId"]),
  }),
  Object.freeze({
    name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.profileRegisteredTenant,
    tableName: USER_COMMERCIAL_PROFILE_TABLE,
    columns: Object.freeze(["registeredTenantId"]),
  }),
  Object.freeze({
    name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.attributionHistoryUserTime,
    tableName: USER_TENANT_ATTRIBUTION_HISTORY_TABLE,
    columns: Object.freeze(["userId", "createdAt"]),
  }),
  Object.freeze({
    name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.allocationIdempotency,
    tableName: COMMERCIAL_CONSUMPTION_ALLOCATION_TABLE,
    columns: Object.freeze(["idempotencyKey"]),
    unique: true,
  }),
  Object.freeze({
    name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.allocationUserTime,
    tableName: COMMERCIAL_CONSUMPTION_ALLOCATION_TABLE,
    columns: Object.freeze(["userId", "capturedAt"]),
  }),
  Object.freeze({
    name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.allocationCollectorTime,
    tableName: COMMERCIAL_CONSUMPTION_ALLOCATION_TABLE,
    columns: Object.freeze(["collectorTenantId", "capturedAt"]),
  }),
  Object.freeze({
    name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.allocationOwnerTime,
    tableName: COMMERCIAL_CONSUMPTION_ALLOCATION_TABLE,
    columns: Object.freeze(["ownerTenantIdSnapshot", "capturedAt"]),
  }),
  Object.freeze({
    name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.providerCostUsageProvider,
    tableName: PROVIDER_COST_LEDGER_TABLE,
    columns: Object.freeze(["usageId", "provider"]),
  }),
  Object.freeze({
    name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.providerCostPeriod,
    tableName: PROVIDER_COST_LEDGER_TABLE,
    columns: Object.freeze(["billingPeriod"]),
  }),
  Object.freeze({
    name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.providerCostState,
    tableName: PROVIDER_COST_LEDGER_TABLE,
    columns: Object.freeze(["state"]),
  }),
  Object.freeze({
    name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.settlementPeriodKey,
    tableName: TENANT_SETTLEMENT_PERIOD_TABLE,
    columns: Object.freeze(["periodKey"]),
    unique: true,
  }),
  Object.freeze({
    name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.commercialTenantStatus,
    tableName: COMMERCIAL_TENANT_TABLE,
    columns: Object.freeze(["status"]),
  }),
  Object.freeze({
    name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.tenantDomainHostname,
    tableName: TENANT_DOMAIN_TABLE,
    columns: Object.freeze(["hostname"]),
  }),
  Object.freeze({
    name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.tenantDomainTenantState,
    tableName: TENANT_DOMAIN_TABLE,
    columns: Object.freeze(["tenantId", "lifecycleState"]),
  }),
  Object.freeze({
    name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.tenantDomainState,
    tableName: TENANT_DOMAIN_TABLE,
    columns: Object.freeze(["lifecycleState"]),
  }),
  Object.freeze({
    name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.domainVerificationDomainState,
    tableName: DOMAIN_VERIFICATION_TABLE,
    columns: Object.freeze(["domainId", "state"]),
  }),
  Object.freeze({
    name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.tenantCertificateTenantStatus,
    tableName: TENANT_CERTIFICATE_TABLE,
    columns: Object.freeze(["tenantId", "status"]),
  }),
  Object.freeze({
    name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.tenantCertificateNotAfter,
    tableName: TENANT_CERTIFICATE_TABLE,
    columns: Object.freeze(["notAfter"]),
  }),
  Object.freeze({
    name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.tenantIngressBindingDomain,
    tableName: TENANT_INGRESS_BINDING_TABLE,
    columns: Object.freeze(["domainId"]),
    unique: true,
  }),
  Object.freeze({
    name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.tenantDomainOperationIdempotency,
    tableName: TENANT_DOMAIN_OPERATION_TABLE,
    columns: Object.freeze(["idempotencyKey"]),
    unique: true,
  }),
  Object.freeze({
    name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.tenantDomainOperationDomainState,
    tableName: TENANT_DOMAIN_OPERATION_TABLE,
    columns: Object.freeze(["domainId", "state"]),
  }),
  Object.freeze({
    name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.creditLotCollectorTime,
    tableName: COMMERCIAL_CREDIT_LOT_TABLE,
    columns: Object.freeze(["collectorTenantId", "createdAt"]),
  }),
  Object.freeze({
    name: MULTI_TENANT_DOMAIN_ALB_RELEASE_INDEXES.paymentOrderCollectorTime,
    tableName: PAYMENT_ORDER_TABLE,
    columns: Object.freeze(["collectorTenantId", "createdAt"]),
  }),
]);

/**
 * Critical catalog facts proven by schema 51. Type facts are only emitted for
 * the cross-dialect canonical types the release schema verifier recognizes.
 * Named index and uniqueness facts are emitted solely by NAMED_INDEXES to keep
 * the identifier list free of duplicates.
 */
function tableConstraintFacts(tableName: string, spec: TableSpec): string[] {
  const facts = [
    `table:${tableName}`,
    `primary-key:${tableName}.${spec.primaryKey.join(".")}`,
  ];
  for (const [columnName, column] of Object.entries(spec.columns)) {
    facts.push(`column:${tableName}.${columnName}`);
    if (!column.nullable) facts.push(`not-null:${tableName}.${columnName}`);
    if (column.type === "text" || column.type === "bigint") {
      facts.push(`type:${tableName}.${columnName}.${column.type}`);
    }
  }
  return facts;
}

export const MULTI_TENANT_DOMAIN_ALB_RELEASE_REQUIRED_CONSTRAINTS = [
  ...Object.entries(TABLE_SPECS).flatMap(([tableName, spec]) => (
    tableConstraintFacts(tableName, spec)
  )),
  ...Object.entries(ALTERED_TABLE_COLUMNS).flatMap(([tableName, columns]) => (
    Object.entries(columns).flatMap(([columnName, column]) => {
      const facts = [`column:${tableName}.${columnName}`];
      if (!column.nullable) facts.push(`not-null:${tableName}.${columnName}`);
      if (column.type === "text" || column.type === "bigint") {
        facts.push(`type:${tableName}.${columnName}.${column.type}`);
      }
      return facts;
    })
  )),
  ...NAMED_INDEXES.flatMap((index) => {
    const facts = [`index:${index.tableName}.${index.name}`];
    if (index.unique) {
      facts.push(`unique-tuple:${index.tableName}.${index.columns.join(".")}`);
      if (index.columns.length === 1) {
        facts.push(`unique-column:${index.tableName}.${index.columns[0]}`);
      }
    }
    return facts;
  }),
] as const;

function migrationError(message: string): Error {
  return new Error(`Migration multi_tenant_domain_alb_release ${message}`);
}

function databaseRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  return (result as { rows?: Array<Record<string, unknown>> })?.rows || [];
}

function databaseBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "t";
}

function normalizedColumnDefault(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let normalized = String(value).trim();
  while (normalized.startsWith("(") && normalized.endsWith(")")) {
    normalized = normalized.slice(1, normalized.length - 1).trim();
  }
  normalized = normalized.replace(/::(?:text|bigint|integer|boolean)$/u, "");
  if (normalized.startsWith("'") && normalized.endsWith("'")) {
    normalized = normalized.slice(1, normalized.length - 1).replace(/''/gu, "'");
  }
  return normalized;
}

/** SQLite stores boolean defaults as 1/0 while PostgreSQL uses true/false. */
function normalizedBooleanDefault(value: string | null): string | null {
  if (value === "1" || value === "t") return "true";
  if (value === "0" || value === "f") return "false";
  return value;
}

function normalizedExpectedDefault(column: ColumnSpec): string | null {
  if (column.default === undefined) return null;
  if (typeof column.default === "boolean") return column.default ? "true" : "false";
  return String(column.default);
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

function assertColumnShape(
  tableName: string,
  columnName: string,
  column: ColumnSpec,
  observed: { defaultValue: string | null; notNull: boolean; type: string } | null,
): void {
  if (!observed) {
    throw migrationError(
      `could not observe column ${tableName}.${columnName} after installation`,
    );
  }
  if (observed.type !== column.type) {
    throw migrationError(
      `found incompatible type for ${tableName}.${columnName}: expected ${column.type}, observed ${observed.type}`,
    );
  }
  if (observed.notNull === column.nullable) {
    throw migrationError(
      `found incompatible nullability for ${tableName}.${columnName}: expected ${column.nullable ? "nullable" : "not-null"}`,
    );
  }
  const expectedDefault = normalizedExpectedDefault(column);
  const observedDefault = column.type === "boolean"
    ? normalizedBooleanDefault(observed.defaultValue)
    : observed.defaultValue;
  if (observedDefault !== expectedDefault) {
    throw migrationError(
      `found incompatible default for ${tableName}.${columnName}: expected ${String(expectedDefault)}, observed ${String(observedDefault)}`,
    );
  }
}

function columnBuilder(
  table: Knex.CreateTableBuilder | Knex.AlterTableBuilder,
  columnName: string,
  column: ColumnSpec,
): void {
  const builder = column.type === "text"
    ? table.text(columnName)
    : column.type === "bigint"
      ? table.bigInteger(columnName)
      : table.boolean(columnName);
  if (!column.nullable) builder.notNullable();
  if (column.default !== undefined) builder.defaultTo(column.default);
}

async function ensureRequiredExistingColumn(
  trx: Knex.Transaction,
  tableName: string,
  columnName: string,
  column: ColumnSpec,
): Promise<void> {
  const before = await readColumnShape(trx, tableName, columnName);
  if (!before) {
    await trx.schema.alterTable(tableName, (table) => {
      columnBuilder(table, columnName, column);
    });
  } else {
    assertColumnShape(tableName, columnName, column, before);
    return;
  }
  const after = await readColumnShape(trx, tableName, columnName);
  assertColumnShape(tableName, columnName, column, after);
}

async function readTableColumns(
  trx: Knex.Transaction,
  tableName: string,
): Promise<string[]> {
  const result = isPostgresClient(trx)
    ? await trx.raw(
      `SELECT column_name AS name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ?
        ORDER BY ordinal_position`,
      [tableName],
    )
    : await trx.raw(
      `SELECT name
         FROM pragma_table_info(?)
        ORDER BY cid`,
      [tableName],
    );
  return databaseRows(result).map((row) => String(row.name));
}

async function readPrimaryKeyColumns(
  trx: Knex.Transaction,
  tableName: string,
): Promise<string[]> {
  if (isPostgresClient(trx)) {
    const rows = databaseRows(await trx.raw(
      `SELECT pg_get_constraintdef(constraint_entry.oid, true) AS definition
         FROM pg_catalog.pg_constraint AS constraint_entry
         JOIN pg_catalog.pg_class AS relation
           ON relation.oid = constraint_entry.conrelid
         JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = current_schema()
          AND relation.relname = ?
          AND constraint_entry.contype = 'p'`,
      [tableName],
    ));
    if (rows.length !== 1) return [];
    const definition = String(rows[0].definition || "");
    const match = definition.match(/^PRIMARY KEY\s*\(\s*(.+?)\s*\)$/i);
    if (!match?.[1]) return [];
    return match[1].split(",").map((part) => part.trim().replace(/^"|"$/g, ""));
  }
  const rows = databaseRows(await trx.raw(
    `SELECT name
       FROM pragma_table_info(?)
      WHERE pk > 0
      ORDER BY pk`,
    [tableName],
  ));
  return rows.map((row) => String(row.name));
}

/**
 * Verify a table that already exists matches the complete schema-51 shape.
 * Partial or extended installs fail closed instead of being silently
 * "repaired".
 */
async function assertCompleteExistingTable(
  trx: Knex.Transaction,
  tableName: string,
): Promise<boolean> {
  if (!(await trx.schema.hasTable(tableName))) return false;
  const spec = TABLE_SPECS[tableName];
  const expectedColumns = Object.keys(spec.columns);
  const actualColumns = await readTableColumns(trx, tableName);
  const missing = expectedColumns.filter((columnName) => !actualColumns.includes(columnName));
  const unexpected = actualColumns.filter((columnName) => !expectedColumns.includes(columnName));
  if (missing.length || unexpected.length) {
    throw migrationError(
      `found partial historical table ${tableName}; missing ${missing.join(",")}; unexpected ${unexpected.join(",")}`,
    );
  }
  for (const [columnName, column] of Object.entries(spec.columns)) {
    const shape = await readColumnShape(trx, tableName, columnName);
    assertColumnShape(tableName, columnName, column, shape);
  }
  const primaryKey = await readPrimaryKeyColumns(trx, tableName);
  if (primaryKey.join(".") !== spec.primaryKey.join(".")) {
    throw migrationError(
      `found incompatible primary key for ${tableName}: expected ${spec.primaryKey.join(",")}, observed ${primaryKey.join(",")}`,
    );
  }
  return true;
}

function createTableBuilder(spec: TableSpec): (table: Knex.CreateTableBuilder) => void {
  return (table) => {
    for (const [columnName, column] of Object.entries(spec.columns)) {
      columnBuilder(table, columnName, column);
    }
    table.primary([...spec.primaryKey]);
    for (const uniqueIndex of spec.uniqueIndexes) {
      table.unique([...uniqueIndex.columns], uniqueIndex.name);
    }
    for (const inlineIndex of spec.inlineIndexes) {
      table.index([...inlineIndex]);
    }
  };
}

interface NamedIndexShape {
  columns: string[];
  unique: boolean;
  exactShape: boolean;
}

async function readNamedIndex(
  trx: Knex.Transaction,
  input: RequiredIndex,
): Promise<NamedIndexShape | null> {
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

function assertIndexShape(actual: NamedIndexShape, expected: RequiredIndex): void {
  if (
    !actual.exactShape
    || actual.unique !== Boolean(expected.unique)
    || actual.columns.length !== expected.columns.length
    || actual.columns.some((column, index) => column !== expected.columns[index])
  ) {
    throw migrationError(
      `found incompatible named index ${expected.name} on ${expected.tableName}`,
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
    throw migrationError(`could not verify named index ${input.name}`);
  }
  assertIndexShape(created, input);
}

/**
 * Deterministic legacy attribution backfill, identical to the documented
 * runtime rule: registeredTenantId=FANJIN, registrationSource=legacy_default,
 * ownerTenantId falls back to FANJIN only when empty.
 */
async function backfillLegacyAttribution(trx: Knex.Transaction): Promise<void> {
  await trx(USER_COMMERCIAL_PROFILE_TABLE)
    .whereNull("registeredTenantId")
    .update({
      registeredTenantId: LEGACY_DEFAULT_TENANT_ID,
      registrationSource: LEGACY_REGISTRATION_SOURCE,
      ownerTenantId: trx.raw(
        `COALESCE(NULLIF("ownerTenantId", ''), '${LEGACY_DEFAULT_TENANT_ID}')`,
      ),
    });
}

export async function upMultiTenantDomainAlbRelease(
  trx: Knex.Transaction,
): Promise<void> {
  for (const parentTable of [
    USER_COMMERCIAL_PROFILE_TABLE,
    COMMERCIAL_CREDIT_LOT_TABLE,
    PAYMENT_ORDER_TABLE,
  ]) {
    if (!(await trx.schema.hasTable(parentTable))) {
      throw migrationError(
        `requires historical table ${parentTable} from schema 50`,
      );
    }
  }

  for (const [tableName, columns] of Object.entries(ALTERED_TABLE_COLUMNS)) {
    for (const [columnName, column] of Object.entries(columns)) {
      await ensureRequiredExistingColumn(trx, tableName, columnName, column);
    }
  }

  for (const [tableName, spec] of Object.entries(TABLE_SPECS)) {
    if (await assertCompleteExistingTable(trx, tableName)) continue;
    await trx.schema.createTable(tableName, createTableBuilder(spec));
    if (!(await assertCompleteExistingTable(trx, tableName))) {
      throw migrationError(`could not verify created table ${tableName}`);
    }
  }

  for (const index of NAMED_INDEXES) {
    await ensureExactIndex(trx, index);
  }

  await backfillLegacyAttribution(trx);
}

export async function downMultiTenantDomainAlbRelease(): Promise<void> {
  throw new Error(
    "Migration multi_tenant_domain_alb_release cannot be rolled back: attribution, allocation, cost and ingress operation rows are immutable operational evidence.",
  );
}
