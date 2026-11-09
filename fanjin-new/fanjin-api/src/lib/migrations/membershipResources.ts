import type { Knex } from "knex";
import { MEMBERSHIP_PLANS, MEMBERSHIP_VERSION } from "../membershipCatalog";

export const RESOURCE_TABLES = { account: "o_workspace_resource_account", execution: "o_workspace_execution", storage: "o_workspace_storage" } as const;
export const RESOURCE_CONSTRAINTS = [
  ...Object.values(RESOURCE_TABLES).map(name => `table:${name}`),
  `index:${RESOURCE_TABLES.execution}.idx_workspace_execution_state`,
  `index:${RESOURCE_TABLES.storage}.idx_workspace_storage_state`,
];
export async function upMembershipResources(trx: Knex.Transaction) {
  await trx.schema.createTable(RESOURCE_TABLES.account, t => {
    t.text("workspaceId").primary(); t.boolean("inventoryReady").notNullable().defaultTo(false);
    t.text("inventoryEvidence").notNullable().defaultTo("{}"); t.bigInteger("updatedAt").notNullable();
  });
  await trx.schema.createTable(RESOURCE_TABLES.execution, t => {
    t.text("id").primary(); t.text("workspaceId").notNullable(); t.text("endpointType").notNullable();
    t.text("state").notNullable(); t.bigInteger("storageBytes").notNullable();
    t.bigInteger("createdAt").notNullable(); t.bigInteger("updatedAt").notNullable(); t.text("releaseProof");
    t.index(["workspaceId", "state"], "idx_workspace_execution_state");
    t.check('"state" IN (\'queued\', \'reserved\', \'dispatched\', \'released\')');
    t.check('"storageBytes" >= 0');
  });
  await trx.schema.createTable(RESOURCE_TABLES.storage, t => {
    t.text("id").primary(); t.text("workspaceId").notNullable(); t.text("objectKey").notNullable();
    t.text("providerFingerprint").notNullable(); t.text("versionId"); t.text("state").notNullable();
    t.bigInteger("bytes").notNullable(); t.boolean("temporary").notNullable().defaultTo(false);
    t.bigInteger("createdAt").notNullable(); t.bigInteger("updatedAt").notNullable(); t.text("evidence").notNullable();
    t.index(["workspaceId", "state"], "idx_workspace_storage_state");
    t.check('"state" IN (\'reserved\', \'stored\', \'released\')'); t.check('"bytes" >= 0');
  });
  const updatedAt = Date.now();
  // Do not modify paid quotes, cash, gifts or their expiry. New offers use V2.
  await trx("o_membership_control").update({ salesEnabled: false, version: MEMBERSHIP_VERSION, updatedAt });
  for (const plan of MEMBERSHIP_PLANS) await trx("o_membership_product").where({ id: plan.id })
    .update({ version: MEMBERSHIP_VERSION, configuration: JSON.stringify(plan), updatedAt });
  // Existing workspaces must be inventoried before resource limits are activated.
  const workspaces = await trx("o_workspace").select("id");
  for (const row of workspaces) await trx(RESOURCE_TABLES.account).insert({ workspaceId: row.id, inventoryReady: false, updatedAt });
  // Preserve occupancy of requests that already crossed the upstream boundary.
  if (await trx.schema.hasTable("o_billing_ledger") && await trx.schema.hasTable("o_usage_record")) {
    const rows = await trx("o_billing_ledger as l").join("o_usage_record as u", "u.id", "l.relatedUsageId")
      .where("l.type", "freeze").where("l.remainingMicros", ">", 0)
      .whereIn("u.endpointType", ["image_generation", "video_generation"])
      .select("l.id", "l.workspaceId", "l.metadata", "u.endpointType");
    for (const row of rows) {
      const metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
      if (!["dispatch_started", "pending_reconcile"].includes(metadata?.billingLifecycleState)) continue;
      await trx(RESOURCE_TABLES.execution).insert({ id: row.id, workspaceId: row.workspaceId, endpointType: row.endpointType,
        state: "dispatched", storageBytes: row.endpointType === "video_generation" ? 250e6 : 32e6, createdAt: updatedAt, updatedAt });
    }
    // Returning customer funds is not proof that an unknown provider request
    // ended. Preserve those slots even when the original freeze is now zero.
    const absorbed = await trx("o_billing_ledger as r").join("o_billing_ledger as l", "l.id", "r.relatedLedgerId")
      .join("o_usage_record as u", "u.id", "l.relatedUsageId").where("r.type", "release").where("l.type", "freeze")
      .whereIn("u.endpointType", ["image_generation", "video_generation"])
      .select("l.id", "l.workspaceId", "r.metadata", "u.endpointType");
    for (const row of absorbed) {
      const metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
      if (metadata?.releaseProof !== "customer_not_delivered_platform_absorbed"
        || Number.isSafeInteger(metadata?.platformAbsorption?.observedReturnedUnits)) continue;
      await trx(RESOURCE_TABLES.execution).insert({ id: row.id, workspaceId: row.workspaceId, endpointType: row.endpointType,
        state: "dispatched", storageBytes: row.endpointType === "video_generation" ? 250e6 : 32e6, createdAt: updatedAt, updatedAt })
        .onConflict("id").ignore();
    }
  }
}
export async function downMembershipResources(): Promise<void> {
  throw new Error("Resource occupancy and deletion evidence must be preserved; use a forward repair.");
}
