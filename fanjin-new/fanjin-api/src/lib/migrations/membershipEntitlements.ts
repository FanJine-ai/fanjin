import type { Knex } from "knex";
import { MEMBERSHIP_V1_PLANS as MEMBERSHIP_PLANS, MEMBERSHIP_V1_VERSION as MEMBERSHIP_VERSION } from "../membershipCatalog";

export const MEMBERSHIP_TABLES = {
  control: "o_membership_control", product: "o_membership_product",
  subscription: "o_membership_subscription", period: "o_membership_period",
} as const;
export const MEMBERSHIP_REQUIRED_CONSTRAINTS = [
  ...Object.values(MEMBERSHIP_TABLES).map(name => `table:${name}`),
  "index:o_membership_subscription.uq_membership_payment_order",
  "index:o_membership_period.uq_membership_subscription_period",
  "index:o_membership_period.idx_membership_due",
] as const;

export async function upMembershipEntitlements(trx: Knex.Transaction) {
  await trx.schema.createTable(MEMBERSHIP_TABLES.control, table => {
    table.text("tenantId").primary(); table.boolean("salesEnabled").notNullable().defaultTo(false);
    table.boolean("authorizationEnabled").notNullable().defaultTo(false);
    table.text("version").notNullable(); table.text("fundingRules").notNullable().defaultTo("[]"); table.bigInteger("updatedAt").notNullable();
  });
  await trx.schema.createTable(MEMBERSHIP_TABLES.product, table => {
    table.text("id").primary(); table.text("version").notNullable(); table.text("configuration").notNullable();
    table.boolean("enabled").notNullable().defaultTo(true); table.bigInteger("updatedAt").notNullable();
  });
  await trx.schema.createTable(MEMBERSHIP_TABLES.subscription, table => {
    table.text("id").primary(); table.text("paymentOrderId").notNullable(); table.text("tenantId").notNullable();
    table.text("workspaceId").notNullable(); table.bigInteger("ownerUserId").notNullable(); table.bigInteger("payerUserId").notNullable();
    table.text("planId").notNullable(); table.text("quote").notNullable();
    table.text("status").notNullable().defaultTo("active"); table.bigInteger("startsAt").notNullable();
    table.bigInteger("endsAt").notNullable(); table.bigInteger("createdAt").notNullable(); table.bigInteger("updatedAt").notNullable();
    table.unique(["paymentOrderId"], { indexName: "uq_membership_payment_order" });
    table.index(["workspaceId", "status", "endsAt"], "idx_membership_workspace_period");
    table.foreign("paymentOrderId").references("id").inTable("o_payment_order").onDelete("RESTRICT");
    table.foreign("workspaceId").references("id").inTable("o_workspace").onDelete("RESTRICT");
    table.check('"endsAt" > "startsAt" AND "ownerUserId" > 0 AND "payerUserId" > 0');
    table.check('"status" IN (\'active\', \'refund_pending\', \'refunded\', \'cancelled\')');
  });
  await trx.schema.createTable(MEMBERSHIP_TABLES.period, table => {
    table.text("id").primary(); table.text("subscriptionId").notNullable(); table.integer("periodIndex").notNullable();
    table.bigInteger("dueAt").notNullable(); table.text("status").notNullable().defaultTo("pending");
    table.bigInteger("grantedAt"); table.text("grantIds").notNullable().defaultTo("[]");
    table.text("lastError"); table.bigInteger("updatedAt").notNullable();
    table.foreign("subscriptionId").references("id").inTable(MEMBERSHIP_TABLES.subscription).onDelete("RESTRICT");
    table.unique(["subscriptionId", "periodIndex"], { indexName: "uq_membership_subscription_period" });
    table.index(["status", "dueAt"], "idx_membership_due");
    table.check('"periodIndex" >= 0 AND "periodIndex" < 12');
    table.check('"status" IN (\'pending\', \'granted\', \'cancelled\')');
  });
  const updatedAt = Date.now();
  await trx(MEMBERSHIP_TABLES.control).insert({ tenantId: "FANJIN", salesEnabled: false, authorizationEnabled: false, version: MEMBERSHIP_VERSION, updatedAt });
  await trx(MEMBERSHIP_TABLES.product).insert(MEMBERSHIP_PLANS.map(plan => ({ id: plan.id, version: MEMBERSHIP_VERSION, configuration: JSON.stringify(plan), enabled: true, updatedAt })));
}

export async function downMembershipEntitlements(): Promise<void> {
  throw new Error("Membership orders and grant evidence must be preserved; disable new sales and use a forward repair.");
}
