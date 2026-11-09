import type { Knex } from "knex";
import { v4 as uuid } from "uuid";

type WorkspaceBillingDb = Knex | Knex.Transaction;

export const DEFAULT_WORKSPACE_BILLING_CURRENCY = "GU";

function table(client: WorkspaceBillingDb, name: string) {
  return (client as Knex)<any>(name);
}

export async function ensureWorkspaceBillingAccountRecord(
  client: WorkspaceBillingDb,
  input: {
    workspaceId: string;
    accountId?: string;
    currency?: string;
    billingMode?: "prepaid" | "postpaid" | "hybrid";
    timestamp?: number;
  },
): Promise<any> {
  const workspaceId = String(input.workspaceId || "").trim();
  if (!workspaceId) throw new Error("工作区 ID 不能为空");

  const existing = await table(client, "o_billing_account").where({ workspaceId }).first();
  if (existing) return existing;

  const timestamp = input.timestamp ?? Date.now();
  await table(client, "o_billing_account")
    .insert({
      id: input.accountId || uuid(),
      workspaceId,
      planId: null,
      currency: String(input.currency || DEFAULT_WORKSPACE_BILLING_CURRENCY).trim().toUpperCase(),
      balanceMicros: 0,
      creditLimitMicros: 0,
      reservedMicros: 0,
      status: "active",
      billingMode: input.billingMode || "prepaid",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflict("workspaceId")
    .ignore();

  const created = await table(client, "o_billing_account").where({ workspaceId }).first();
  if (!created) throw new Error("计费账户创建失败");
  return created;
}

export async function provisionMissingActiveWorkspaceBillingAccounts(
  client: WorkspaceBillingDb,
): Promise<number> {
  const missing = await table(client, "o_workspace as workspace")
    .leftJoin("o_billing_account as account", "workspace.id", "account.workspaceId")
    .where("workspace.status", "active")
    .whereNull("account.id")
    .select("workspace.id as workspaceId");
  if (!missing.length) return 0;

  const timestamp = Date.now();
  await table(client, "o_billing_account")
    .insert(missing.map((row: any) => ({
      id: uuid(),
      workspaceId: String(row.workspaceId),
      planId: null,
      currency: DEFAULT_WORKSPACE_BILLING_CURRENCY,
      balanceMicros: 0,
      creditLimitMicros: 0,
      reservedMicros: 0,
      status: "active",
      billingMode: "prepaid",
      createdAt: timestamp,
      updatedAt: timestamp,
    })))
    .onConflict("workspaceId")
    .ignore();

  return missing.length;
}
