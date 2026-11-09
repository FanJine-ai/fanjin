import type { Knex } from "knex";

import { RELEASE_DEPLOYMENT_TABLE } from "@/lib/migrations/releaseDeploymentOrchestration";

export const RELEASE_DEPLOYMENT_RECONCILIATION_TABLE = "o_release_deployment_reconciliation";

export const RELEASE_DEPLOYMENT_RECONCILIATION_INDEXES = {
  idempotencyKey: "uq_o_release_reconcile_idempotency",
  activeDeployment: "uq_o_release_reconcile_active_deployment",
  deploymentCreated: "idx_o_release_reconcile_deployment_created",
  statusCreated: "idx_o_release_reconcile_status_created",
  lease: "idx_o_release_reconcile_lease",
} as const;

/**
 * Durable operator request consumed only by the independent Release
 * Controller. The API process never receives CLB or SSH credentials.
 *
 * `activeDeploymentId` is deliberately nullable and unique. A queued/running
 * request keeps it populated, preventing two Controllers from attempting to
 * resolve the same degraded deployment. Terminal requests clear it so a root
 * operator can retry after fixing the fleet without deleting audit history.
 */
export async function upReleaseDeploymentReconciliation(trx: Knex.Transaction): Promise<void> {
  if (!(await trx.schema.hasTable(RELEASE_DEPLOYMENT_TABLE))) {
    throw new Error(
      `${RELEASE_DEPLOYMENT_TABLE} is missing; apply release_deployment_orchestration before release_deployment_reconciliation.`,
    );
  }
  if (await trx.schema.hasTable(RELEASE_DEPLOYMENT_RECONCILIATION_TABLE)) return;

  await trx.schema.createTable(RELEASE_DEPLOYMENT_RECONCILIATION_TABLE, (table) => {
    table.text("id").notNullable().primary();
    table.text("deploymentId").notNullable();
    table.text("activeDeploymentId");
    table.text("intent").notNullable();
    table.text("status").notNullable().defaultTo("queued");
    table.text("reason").notNullable();
    table.text("idempotencyKey").notNullable();
    table.text("requestHash").notNullable();
    table.bigInteger("requestedDeploymentRevision").notNullable();
    table.bigInteger("requestedByUserId").notNullable();
    table.text("leaseOwner");
    table.bigInteger("leaseExpiresAt");
    table.bigInteger("fencingToken").notNullable().defaultTo(1);
    table.text("evidenceJson").notNullable().defaultTo("{}");
    table.text("errorCode");
    table.text("safeError");
    table.bigInteger("startedAt");
    table.bigInteger("completedAt");
    table.bigInteger("revision").notNullable().defaultTo(1);
    table.bigInteger("createdAt").notNullable();
    table.bigInteger("updatedAt").notNullable();

    table
      .foreign("deploymentId", "fk_o_release_reconcile_deployment")
      .references("id")
      .inTable(RELEASE_DEPLOYMENT_TABLE)
      .onDelete("RESTRICT");
    table
      .foreign("activeDeploymentId", "fk_o_release_reconcile_active_deployment")
      .references("id")
      .inTable(RELEASE_DEPLOYMENT_TABLE)
      .onDelete("RESTRICT");
    table.unique(["idempotencyKey"], RELEASE_DEPLOYMENT_RECONCILIATION_INDEXES.idempotencyKey);
    table.unique(["activeDeploymentId"], RELEASE_DEPLOYMENT_RECONCILIATION_INDEXES.activeDeployment);
    table.index(["deploymentId", "createdAt"], RELEASE_DEPLOYMENT_RECONCILIATION_INDEXES.deploymentCreated);
    table.index(["status", "createdAt"], RELEASE_DEPLOYMENT_RECONCILIATION_INDEXES.statusCreated);
    table.index(["leaseExpiresAt", "status"], RELEASE_DEPLOYMENT_RECONCILIATION_INDEXES.lease);

    table.check('"intent" IN (\'previous\', \'target\')', {}, "chk_o_release_reconcile_intent");
    table.check(
      '"status" IN (\'queued\', \'running\', \'succeeded\', \'failed\')',
      {},
      "chk_o_release_reconcile_status",
    );
    table.check('length("reason") BETWEEN 3 AND 500', {}, "chk_o_release_reconcile_reason");
    table.check('length("requestHash") = 64', {}, "chk_o_release_reconcile_request_hash");
    table.check('"requestedDeploymentRevision" >= 1', {}, "chk_o_release_reconcile_requested_revision");
    table.check('"requestedByUserId" > 0', {}, "chk_o_release_reconcile_requested_by");
    table.check('"fencingToken" >= 1', {}, "chk_o_release_reconcile_fencing");
    table.check('"revision" >= 1', {}, "chk_o_release_reconcile_revision");
    table.check(
      '("status" IN (\'queued\', \'running\') AND "activeDeploymentId" = "deploymentId" AND "completedAt" IS NULL) OR '
        + '("status" IN (\'succeeded\', \'failed\') AND "activeDeploymentId" IS NULL AND "completedAt" IS NOT NULL)',
      {},
      "chk_o_release_reconcile_active",
    );
    table.check(
      '("leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL) OR '
        + '("status" = \'running\' AND "leaseOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)',
      {},
      "chk_o_release_reconcile_lease",
    );
  });
}

export async function downReleaseDeploymentReconciliation(): Promise<void> {
  throw new Error(
    "Migration release_deployment_reconciliation cannot be rolled back safely because manual production recovery requests and evidence are audit records.",
  );
}
