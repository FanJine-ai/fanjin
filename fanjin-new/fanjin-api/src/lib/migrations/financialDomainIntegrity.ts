import type { Knex } from "knex";

export const ACTIVE_TENANT_DOMAIN_HOSTNAME_INDEX =
  "uq_o_tenant_domain_active_hostname" as const;
export const PROVIDER_COST_USAGE_PROVIDER_INDEX =
  "uq_o_provider_cost_ledger_usage_provider" as const;

export const FINANCIAL_DOMAIN_INTEGRITY_REQUIRED_CONSTRAINTS = [
  `index:o_tenant_domain.${ACTIVE_TENANT_DOMAIN_HOSTNAME_INDEX}`,
  `index:o_provider_cost_ledger.${PROVIDER_COST_USAGE_PROVIDER_INDEX}`,
] as const;

async function assertNoDuplicateRows(trx: Knex.Transaction): Promise<void> {
  const duplicateHostname = await trx("o_tenant_domain")
    .whereNull("deletedAt")
    .select("hostname")
    .groupBy("hostname")
    .havingRaw("COUNT(*) > 1")
    .first();
  if (duplicateHostname) {
    throw new Error(
      `Migration financial_domain_integrity found duplicate active hostname: ${String(duplicateHostname.hostname)}`,
    );
  }
  const duplicateProviderCost = await trx("o_provider_cost_ledger")
    .whereNotNull("usageId")
    .select("usageId", "provider")
    .groupBy("usageId", "provider")
    .havingRaw("COUNT(*) > 1")
    .first();
  if (duplicateProviderCost) {
    throw new Error(
      `Migration financial_domain_integrity found duplicate provider cost: ${String(duplicateProviderCost.usageId)}/${String(duplicateProviderCost.provider)}`,
    );
  }
}

/**
 * Schema 52 — fix-forward integrity constraints for schema 51.
 *
 * Both indexes are partial so historical soft-deleted domains and cost rows
 * without a canonical usage id remain representable. Existing schema-51
 * binaries already use these logical keys, therefore 51/52 remains a safe
 * rolling and rollback window.
 */
export async function upFinancialDomainIntegrity(trx: Knex.Transaction): Promise<void> {
  await assertNoDuplicateRows(trx);
  await trx.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS "${ACTIVE_TENANT_DOMAIN_HOSTNAME_INDEX}"
     ON "o_tenant_domain" ("hostname") WHERE "deletedAt" IS NULL`,
  );
  await trx.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS "${PROVIDER_COST_USAGE_PROVIDER_INDEX}"
     ON "o_provider_cost_ledger" ("usageId", "provider") WHERE "usageId" IS NOT NULL`,
  );
}

export async function downFinancialDomainIntegrity(trx: Knex.Transaction): Promise<void> {
  await trx.raw(`DROP INDEX IF EXISTS "${PROVIDER_COST_USAGE_PROVIDER_INDEX}"`);
  await trx.raw(`DROP INDEX IF EXISTS "${ACTIVE_TENANT_DOMAIN_HOSTNAME_INDEX}"`);
}
