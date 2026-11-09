import type { Knex } from "knex";

export const ONLINE_PAYMENT_ORDER_TABLE = "o_payment_order";
export const ONLINE_PAYMENT_EVENT_TABLE = "o_payment_event";

export const ONLINE_PAYMENT_ORDER_REQUIRED_CONSTRAINTS = [
  "table:o_payment_order",
  "table:o_payment_event",
  "index:o_payment_order.uq_o_payment_order_out_trade_no",
  "index:o_payment_order.uq_o_payment_order_tenant_user_idempotency",
  "index:o_payment_order.idx_o_payment_order_tenant_status_time",
  "index:o_payment_order.idx_o_payment_order_user_time",
  "index:o_payment_event.uq_o_payment_event_event_key",
  "index:o_payment_event.idx_o_payment_event_order_time",
] as const;

export async function upOnlinePaymentOrder(trx: Knex.Transaction): Promise<void> {
  if (!(await trx.schema.hasTable(ONLINE_PAYMENT_ORDER_TABLE))) {
    await trx.schema.createTable(ONLINE_PAYMENT_ORDER_TABLE, (table) => {
      table.text("id").notNullable().primary();
      table.text("outTradeNo").notNullable();
      table.text("sellerTenantId").notNullable();
      table.text("workspaceId").notNullable();
      table.bigInteger("userId").notNullable();
      table.text("channelKey").notNullable();
      table.text("protocol").notNullable();
      table.text("providerOrderId");
      table.text("status").notNullable().defaultTo("created");
      table.bigInteger("amountMicros").notNullable();
      table.bigInteger("creditedGuMicros").notNullable();
      table.bigInteger("refundedAmountMicros").notNullable().defaultTo(0);
      table.text("currency").notNullable().defaultTo("CNY");
      table.text("description").notNullable();
      table.text("clientReturnUrl");
      table.text("idempotencyKey").notNullable();
      table.text("providerPayloadDigest");
      table.text("walletLedgerId");
      table.text("creditLotId");
      table.text("metadata").notNullable().defaultTo("{}");
      table.bigInteger("expiresAt").notNullable();
      table.bigInteger("paidAt");
      table.bigInteger("refundedAt");
      table.bigInteger("createdAt").notNullable();
      table.bigInteger("updatedAt").notNullable();
      table.bigInteger("revision").notNullable().defaultTo(0);
      table.unique(["outTradeNo"], { indexName: "uq_o_payment_order_out_trade_no" });
      table.unique(["sellerTenantId", "userId", "idempotencyKey"], {
        indexName: "uq_o_payment_order_tenant_user_idempotency",
      });
      table.index(["sellerTenantId", "status", "createdAt"], "idx_o_payment_order_tenant_status_time");
      table.index(["userId", "createdAt"], "idx_o_payment_order_user_time");
    });
  }

  if (!(await trx.schema.hasTable(ONLINE_PAYMENT_EVENT_TABLE))) {
    await trx.schema.createTable(ONLINE_PAYMENT_EVENT_TABLE, (table) => {
      table.text("id").notNullable().primary();
      table.text("orderId").notNullable();
      table.text("eventKey").notNullable();
      table.text("eventType").notNullable();
      table.text("payloadDigest").notNullable();
      table.text("status").notNullable();
      table.text("metadata").notNullable().defaultTo("{}");
      table.bigInteger("createdAt").notNullable();
      table.bigInteger("processedAt");
      table.unique(["eventKey"], { indexName: "uq_o_payment_event_event_key" });
      table.index(["orderId", "createdAt"], "idx_o_payment_event_order_time");
    });
  }
}

export async function downOnlinePaymentOrder(): Promise<void> {
  throw new Error("Online payment financial evidence cannot be rolled back safely or deleted automatically.");
}
