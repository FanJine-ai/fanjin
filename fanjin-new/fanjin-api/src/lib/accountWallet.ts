import { Knex } from "knex";
import { v4 as uuid } from "uuid";
import { db } from "@/utils/db";
import { membershipGrantApplies } from "./membershipCatalog";
import {
  captureCommercialCreditLots,
  releaseCommercialCreditLots,
  reserveCommercialCreditLots,
} from "@/lib/commercialTenant";
import { isPostgresClient } from "@/lib/dbDialect";
import {
  type RuntimeSchemaContract,
  verifyPostgresRuntimeSchema,
} from "@/lib/runtimeSchemaVerification";

type AccountWalletDb = Knex | Knex.Transaction;

export const accountWalletLedgerTypes = [
  "recharge",
  "manual_credit",
  "manual_debit",
  "allocate_to_workspace",
  "auto_allocate_to_default_workspace",
  "refund",
  "gift_grant",
  "gift_expire",
  "gift_revoke",
  "credit_set",
  "spend_reserve",
  "spend_capture",
  "spend_release",
] as const;
export const accountWalletDirections = ["credit", "debit"] as const;

export type AccountWalletLedgerType = (typeof accountWalletLedgerTypes)[number];
export type AccountWalletDirection = (typeof accountWalletDirections)[number];

export interface AccountWallet {
  id: string;
  userId: number;
  currency: string;
  balanceMicros: number;
  giftBalanceMicros: number;
  cashReservedMicros: number;
  giftReservedMicros: number;
  creditLimitMicros: number;
  creditUsedMicros: number;
  creditReservedMicros: number;
  status: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface AccountGiftGrant {
  id: string;
  userId: number;
  currency: string;
  amountMicros: number;
  remainingMicros: number;
  reservedMicros: number;
  expiresAt: number | null;
  status: string;
  campaignName: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  operatorUserId: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AccountWalletLedger {
  id: string;
  walletId: string;
  userId: number;
  workspaceId: string | null;
  workspaceLedgerId: string | null;
  serviceRequestId: string | null;
  incomeRecordId: string | null;
  type: AccountWalletLedgerType;
  direction: AccountWalletDirection;
  amountMicros: number;
  currency: string;
  balanceBeforeMicros: number;
  balanceAfterMicros: number;
  requestId: string | null;
  idempotencyKey: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  operatorUserId: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AccountWalletOperationInput {
  userId: number;
  amountMicros: number;
  currency?: string | null;
  type?: AccountWalletLedgerType;
  workspaceId?: string | null;
  workspaceLedgerId?: string | null;
  serviceRequestId?: string | null;
  incomeRecordId?: string | null;
  requestId?: string | null;
  idempotencyKey?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown>;
  operatorUserId?: number | null;
}

/**
 * The owner account has insufficient spendable GU for a requested reserve.
 *
 * This is intentionally a dedicated error type rather than a message check:
 * billing may translate this deterministic business rejection to HTTP 402,
 * while wallet consistency, concurrency, and database failures must retain
 * their original classification.
 */
export class AccountWalletInsufficientFundsError extends Error {
  readonly code = "ACCOUNT_WALLET_INSUFFICIENT_FUNDS";
  readonly requiredMicros: number | null;
  readonly availableMicros: number | null;

  constructor(
    message = "账号可用额度不足",
    amounts: { requiredMicros?: number; availableMicros?: number } = {},
  ) {
    super(message);
    this.name = "AccountWalletInsufficientFundsError";
    this.requiredMicros = Number.isSafeInteger(amounts.requiredMicros) && Number(amounts.requiredMicros) >= 0
      ? Number(amounts.requiredMicros)
      : null;
    this.availableMicros = Number.isSafeInteger(amounts.availableMicros) && Number(amounts.availableMicros) >= 0
      ? Number(amounts.availableMicros)
      : null;
  }
}

let ensurePromise: Promise<void> | null = null;
const postgresSchemaPromises = new WeakMap<object, Promise<void>>();

const accountWalletRuntimeSchema = {
  errorCode: "ACCOUNT_WALLET_RUNTIME_SCHEMA_INVALID",
  label: "account wallet",
  tables: [
    {
      name: "o_account_wallet",
      columns: [
        "id", "userId", "currency", "balanceMicros", "giftBalanceMicros",
        "cashReservedMicros", "giftReservedMicros", "creditLimitMicros",
        "creditUsedMicros", "creditReservedMicros", "status", "metadata",
        "createdAt", "updatedAt",
      ],
    },
    {
      name: "o_account_gift_grant",
      columns: [
        "id", "userId", "currency", "amountMicros", "remainingMicros",
        "reservedMicros", "expiresAt", "status", "campaignName",
        "description", "metadata", "operatorUserId", "createdAt", "updatedAt",
      ],
    },
    {
      name: "o_account_wallet_ledger",
      columns: [
        "id", "walletId", "userId", "workspaceId", "workspaceLedgerId",
        "serviceRequestId", "incomeRecordId", "type", "direction",
        "amountMicros", "currency", "balanceBeforeMicros",
        "balanceAfterMicros", "requestId", "idempotencyKey", "description",
        "metadata", "operatorUserId", "createdAt", "updatedAt",
      ],
    },
  ],
  indexes: [
    {
      name: "idx_o_account_wallet_user",
      table: "o_account_wallet",
      unique: true,
      columns: ["userId"],
      predicate: null,
    },
    {
      name: "idx_o_account_gift_grant_user_status_expire",
      table: "o_account_gift_grant",
      unique: false,
      columns: ["userId", "status", "expiresAt"],
      predicate: null,
    },
    {
      name: "idx_o_account_wallet_ledger_user_time",
      table: "o_account_wallet_ledger",
      unique: false,
      columns: ["userId", "createdAt"],
      predicate: null,
    },
    {
      name: "idx_o_account_wallet_ledger_workspace_time",
      table: "o_account_wallet_ledger",
      unique: false,
      columns: ["workspaceId", "createdAt"],
      predicate: null,
    },
    {
      name: "idx_o_account_wallet_ledger_wallet_time",
      table: "o_account_wallet_ledger",
      unique: false,
      columns: ["walletId", "createdAt"],
      predicate: null,
    },
    {
      name: "idx_o_account_wallet_ledger_idempotency",
      table: "o_account_wallet_ledger",
      unique: true,
      columns: ["userId", "type", "idempotencyKey"],
      predicate: '"idempotencyKey" IS NOT NULL',
    },
  ],
} as const satisfies RuntimeSchemaContract;

function postgresSchemaCacheKey(client: AccountWalletDb): object {
  const configuredClient = (client as any)?.client;
  return configuredClient && (typeof configuredClient === "object" || typeof configuredClient === "function")
    ? configuredClient
    : (client as unknown as object);
}

async function verifyAccountWalletRuntimeSchema(client: AccountWalletDb): Promise<void> {
  const key = postgresSchemaCacheKey(client);
  let pending = postgresSchemaPromises.get(key);
  if (!pending) {
    pending = verifyPostgresRuntimeSchema(client, accountWalletRuntimeSchema);
    postgresSchemaPromises.set(key, pending);
  }
  await pending;
}

function table(client: AccountWalletDb, tableName: string): Knex.QueryBuilder {
  return (client as any)(tableName);
}

function now(): number {
  return Date.now();
}

function normalizeCurrency(value?: string | null): string {
  return String(value || "GU").trim().toUpperCase() || "GU";
}

function cleanText(value?: string | null): string | null {
  const text = String(value || "").trim();
  return text || null;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (!value || typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function assertUserId(value: number): number {
  const userId = Number(value || 0);
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("userId 不能为空");
  return userId;
}

function assertPositiveAmount(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("账号钱包金额必须是正整数 micros");
  return value;
}

function normalizeLedgerType(value?: string | null): AccountWalletLedgerType {
  return accountWalletLedgerTypes.includes(value as AccountWalletLedgerType) ? (value as AccountWalletLedgerType) : "manual_credit";
}

function normalizeDirection(value?: string | null): AccountWalletDirection {
  return value === "debit" ? "debit" : "credit";
}

export function formatAccountWallet(row: any): AccountWallet {
  return {
    id: String(row.id || ""),
    userId: Number(row.userId || 0),
    currency: normalizeCurrency(row.currency),
    balanceMicros: Number(row.balanceMicros || 0),
    giftBalanceMicros: Number(row.giftBalanceMicros || 0),
    cashReservedMicros: Number(row.cashReservedMicros || 0),
    giftReservedMicros: Number(row.giftReservedMicros || 0),
    creditLimitMicros: Number(row.creditLimitMicros || 0),
    creditUsedMicros: Number(row.creditUsedMicros || 0),
    creditReservedMicros: Number(row.creditReservedMicros || 0),
    status: String(row.status || "active"),
    metadata: parseJsonObject(row.metadata),
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
  };
}

export function formatAccountGiftGrant(row: any): AccountGiftGrant {
  return {
    id: String(row.id || ""),
    userId: Number(row.userId || 0),
    currency: normalizeCurrency(row.currency),
    amountMicros: Number(row.amountMicros || 0),
    remainingMicros: Number(row.remainingMicros || 0),
    reservedMicros: Number(row.reservedMicros || 0),
    expiresAt: row.expiresAt == null ? null : Number(row.expiresAt),
    status: String(row.status || "active"),
    campaignName: row.campaignName || null,
    description: row.description || null,
    metadata: parseJsonObject(row.metadata),
    operatorUserId: row.operatorUserId == null ? null : Number(row.operatorUserId),
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
  };
}

export function formatAccountWalletLedger(row: any): AccountWalletLedger {
  return {
    id: String(row.id || ""),
    walletId: String(row.walletId || ""),
    userId: Number(row.userId || 0),
    workspaceId: row.workspaceId || null,
    workspaceLedgerId: row.workspaceLedgerId || null,
    serviceRequestId: row.serviceRequestId || null,
    incomeRecordId: row.incomeRecordId || null,
    type: normalizeLedgerType(row.type),
    direction: normalizeDirection(row.direction),
    amountMicros: Number(row.amountMicros || 0),
    currency: normalizeCurrency(row.currency),
    balanceBeforeMicros: Number(row.balanceBeforeMicros || 0),
    balanceAfterMicros: Number(row.balanceAfterMicros || 0),
    requestId: row.requestId || null,
    idempotencyKey: row.idempotencyKey || null,
    description: row.description || null,
    metadata: parseJsonObject(row.metadata),
    operatorUserId: row.operatorUserId == null ? null : Number(row.operatorUserId),
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
  };
}

export async function ensureAccountWalletTables(client: AccountWalletDb = db): Promise<void> {
  if (isPostgresClient(client)) {
    await verifyAccountWalletRuntimeSchema(client);
    return;
  }
  if (client !== db) return;
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const hasWallet = await db.schema.hasTable("o_account_wallet");
      if (!hasWallet) {
        await db.schema.createTable("o_account_wallet", (table) => {
          table.text("id").notNullable();
          table.bigInteger("userId").notNullable();
          table.text("currency").notNullable().defaultTo("GU");
          table.bigInteger("balanceMicros").notNullable().defaultTo(0);
          table.bigInteger("giftBalanceMicros").notNullable().defaultTo(0);
          table.bigInteger("cashReservedMicros").notNullable().defaultTo(0);
          table.bigInteger("giftReservedMicros").notNullable().defaultTo(0);
          table.bigInteger("creditLimitMicros").notNullable().defaultTo(0);
          table.bigInteger("creditUsedMicros").notNullable().defaultTo(0);
          table.bigInteger("creditReservedMicros").notNullable().defaultTo(0);
          table.text("status").notNullable().defaultTo("active");
          table.text("metadata").notNullable().defaultTo("{}");
          table.bigInteger("createdAt").notNullable();
          table.bigInteger("updatedAt").notNullable();
          table.primary(["id"]);
        });
      }
      for (const [column, type] of [
        ["giftBalanceMicros", "bigInteger"],
        ["cashReservedMicros", "bigInteger"],
        ["giftReservedMicros", "bigInteger"],
        ["creditLimitMicros", "bigInteger"],
        ["creditUsedMicros", "bigInteger"],
        ["creditReservedMicros", "bigInteger"],
      ] as const) {
        if (!(await db.schema.hasColumn("o_account_wallet", column))) {
          await db.schema.alterTable("o_account_wallet", (table) => (table as any)[type](column).notNullable().defaultTo(0));
        }
      }
      const hasGiftGrant = await db.schema.hasTable("o_account_gift_grant");
      if (!hasGiftGrant) {
        await db.schema.createTable("o_account_gift_grant", (table) => {
          table.text("id").notNullable();
          table.bigInteger("userId").notNullable();
          table.text("currency").notNullable().defaultTo("GU");
          table.bigInteger("amountMicros").notNullable().defaultTo(0);
          table.bigInteger("remainingMicros").notNullable().defaultTo(0);
          table.bigInteger("reservedMicros").notNullable().defaultTo(0);
          table.bigInteger("expiresAt");
          table.text("status").notNullable().defaultTo("active");
          table.text("campaignName");
          table.text("description");
          table.text("metadata").notNullable().defaultTo("{}");
          table.bigInteger("operatorUserId");
          table.bigInteger("createdAt").notNullable();
          table.bigInteger("updatedAt").notNullable();
          table.primary(["id"]);
        });
      }
      const hasLedger = await db.schema.hasTable("o_account_wallet_ledger");
      if (!hasLedger) {
        await db.schema.createTable("o_account_wallet_ledger", (table) => {
          table.text("id").notNullable();
          table.text("walletId").notNullable();
          table.bigInteger("userId").notNullable();
          table.text("workspaceId");
          table.text("workspaceLedgerId");
          table.text("serviceRequestId");
          table.text("incomeRecordId");
          table.text("type").notNullable();
          table.text("direction").notNullable();
          table.bigInteger("amountMicros").notNullable().defaultTo(0);
          table.text("currency").notNullable().defaultTo("GU");
          table.bigInteger("balanceBeforeMicros").notNullable().defaultTo(0);
          table.bigInteger("balanceAfterMicros").notNullable().defaultTo(0);
          table.text("requestId");
          table.text("idempotencyKey");
          table.text("description");
          table.text("metadata").notNullable().defaultTo("{}");
          table.bigInteger("operatorUserId");
          table.bigInteger("createdAt").notNullable();
          table.bigInteger("updatedAt").notNullable();
          table.primary(["id"]);
        });
      }
      await db.raw("CREATE UNIQUE INDEX IF NOT EXISTS ?? ON ?? (??)", [
        "idx_o_account_wallet_user",
        "o_account_wallet",
        "userId",
      ]);
      await db.raw("CREATE INDEX IF NOT EXISTS ?? ON ?? (??, ??, ??)", [
        "idx_o_account_gift_grant_user_status_expire",
        "o_account_gift_grant",
        "userId",
        "status",
        "expiresAt",
      ]);
      await db.raw("CREATE INDEX IF NOT EXISTS ?? ON ?? (??, ??)", [
        "idx_o_account_wallet_ledger_user_time",
        "o_account_wallet_ledger",
        "userId",
        "createdAt",
      ]);
      await db.raw("CREATE INDEX IF NOT EXISTS ?? ON ?? (??, ??)", [
        "idx_o_account_wallet_ledger_workspace_time",
        "o_account_wallet_ledger",
        "workspaceId",
        "createdAt",
      ]);
      await db.raw("CREATE INDEX IF NOT EXISTS ?? ON ?? (??, ??)", [
        "idx_o_account_wallet_ledger_wallet_time",
        "o_account_wallet_ledger",
        "walletId",
        "createdAt",
      ]);
      await db.raw(
        "CREATE UNIQUE INDEX IF NOT EXISTS ?? ON ?? (??, ??, ??) WHERE ?? IS NOT NULL",
        [
          "idx_o_account_wallet_ledger_idempotency",
          "o_account_wallet_ledger",
          "userId",
          "type",
          "idempotencyKey",
          "idempotencyKey",
        ],
      );
    })();
  }
  await ensurePromise;
}

/**
 * Read an existing account wallet without running any schema creation or
 * repair path. Formal readonly evidence projections use this helper so their
 * call graph contains only SELECTs even when the supplied client is a
 * top-level Knex instance rather than a transaction.
 */
export async function readAccountWalletReadonly(
  client: AccountWalletDb,
  userId: number,
): Promise<AccountWallet | null> {
  const row = await table(client, "o_account_wallet").where({ userId: assertUserId(userId) }).first();
  return row ? formatAccountWallet(row) : null;
}

export async function readAccountWallet(client: AccountWalletDb, userId: number): Promise<AccountWallet | null> {
  await ensureAccountWalletTables(client);
  return readAccountWalletReadonly(client, userId);
}

export async function ensureAccountWallet(client: AccountWalletDb, userId: number, currency = "GU"): Promise<AccountWallet> {
  await ensureAccountWalletTables(client);
  const normalizedUserId = assertUserId(userId);
  const existing = await readAccountWallet(client, normalizedUserId);
  if (existing) return existing;

  const timestamp = now();
  const row = {
    id: uuid(),
    userId: normalizedUserId,
    currency: normalizeCurrency(currency),
    balanceMicros: 0,
    giftBalanceMicros: 0,
    cashReservedMicros: 0,
    giftReservedMicros: 0,
    creditLimitMicros: 0,
    creditUsedMicros: 0,
    creditReservedMicros: 0,
    status: "active",
    metadata: "{}",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  try {
    await table(client, "o_account_wallet").insert(row);
  } catch (err) {
    const createdElsewhere = await readAccountWallet(client, normalizedUserId);
    if (createdElsewhere) return createdElsewhere;
    throw err;
  }
  return formatAccountWallet(row);
}

async function findIdempotentLedger(
  client: AccountWalletDb,
  userId: number,
  type: AccountWalletLedgerType,
  idempotencyKey?: string | null,
): Promise<AccountWalletLedger | null> {
  const key = cleanText(idempotencyKey);
  if (!key) return null;
  const row = await table(client, "o_account_wallet_ledger").where({ userId, type, idempotencyKey: key }).first();
  return row ? formatAccountWalletLedger(row) : null;
}

function assertIdempotentCreditMatches(existing: AccountWalletLedger, input: AccountWalletOperationInput, amountMicros: number) {
  const requestedCurrency = normalizeCurrency(input.currency);
  const requestedWorkspaceId = cleanText(input.workspaceId);
  if (
    existing.amountMicros !== amountMicros
    || existing.currency !== requestedCurrency
    || existing.workspaceId !== requestedWorkspaceId
  ) {
    throw new Error("账号钱包幂等键已被不同的充值请求使用");
  }
}

async function insertWalletLedger(
  client: AccountWalletDb,
  input: {
    wallet: AccountWallet;
    type: AccountWalletLedgerType;
    direction: AccountWalletDirection;
    amountMicros: number;
    balanceBeforeMicros: number;
    balanceAfterMicros: number;
    workspaceId?: string | null;
    workspaceLedgerId?: string | null;
    serviceRequestId?: string | null;
    incomeRecordId?: string | null;
    requestId?: string | null;
    idempotencyKey?: string | null;
    description?: string | null;
    metadata?: Record<string, unknown>;
    operatorUserId?: number | null;
  },
): Promise<AccountWalletLedger> {
  const timestamp = now();
  const row = {
    id: uuid(),
    walletId: input.wallet.id,
    userId: input.wallet.userId,
    workspaceId: cleanText(input.workspaceId),
    workspaceLedgerId: cleanText(input.workspaceLedgerId),
    serviceRequestId: cleanText(input.serviceRequestId),
    incomeRecordId: cleanText(input.incomeRecordId),
    type: input.type,
    direction: input.direction,
    amountMicros: input.amountMicros,
    currency: normalizeCurrency(input.wallet.currency),
    balanceBeforeMicros: input.balanceBeforeMicros,
    balanceAfterMicros: input.balanceAfterMicros,
    requestId: cleanText(input.requestId),
    idempotencyKey: cleanText(input.idempotencyKey),
    description: cleanText(input.description),
    metadata: stringifyJson(input.metadata || {}),
    operatorUserId: input.operatorUserId ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await table(client, "o_account_wallet_ledger").insert(row);
  return formatAccountWalletLedger(row);
}

async function updateWalletFields(
  client: AccountWalletDb,
  wallet: AccountWallet,
  fields: Partial<Pick<AccountWallet, "balanceMicros" | "giftBalanceMicros" | "cashReservedMicros" | "giftReservedMicros" | "creditLimitMicros" | "creditUsedMicros" | "creditReservedMicros">>,
): Promise<AccountWallet> {
  const affected = await table(client, "o_account_wallet")
    .where({ id: wallet.id })
    .andWhere({
      balanceMicros: wallet.balanceMicros,
      giftBalanceMicros: wallet.giftBalanceMicros,
      cashReservedMicros: wallet.cashReservedMicros,
      giftReservedMicros: wallet.giftReservedMicros,
      creditLimitMicros: wallet.creditLimitMicros,
      creditUsedMicros: wallet.creditUsedMicros,
      creditReservedMicros: wallet.creditReservedMicros,
    })
    .update({ ...fields, updatedAt: now() });
  if (Number(affected || 0) !== 1) throw new Error("账号钱包额度已变化，请重试");
  const updated = await readAccountWallet(client, wallet.userId);
  if (!updated) throw new Error("账号钱包不存在");
  return updated;
}

async function updateWalletBalance(client: AccountWalletDb, wallet: AccountWallet, balanceMicros: number): Promise<AccountWallet> {
  return updateWalletFields(client, wallet, { balanceMicros });
}

export async function applyAccountWalletCredit(client: AccountWalletDb, input: AccountWalletOperationInput) {
  const userId = assertUserId(input.userId);
  const type = normalizeLedgerType(input.type || "recharge");
  const amountMicros = assertPositiveAmount(Number(input.amountMicros || 0));
  const existing = await findIdempotentLedger(client, userId, type, input.idempotencyKey);
  if (existing) {
    assertIdempotentCreditMatches(existing, input, amountMicros);
    return { wallet: await ensureAccountWallet(client, userId, existing.currency), ledger: existing, idempotent: true };
  }

  const wallet = await ensureAccountWallet(client, userId, input.currency || "GU");
  if (wallet.status !== "active") throw new Error("账号钱包不可用");
  const balanceAfterMicros = wallet.balanceMicros + amountMicros;
  const updated = await updateWalletBalance(client, wallet, balanceAfterMicros);
  const ledger = await insertWalletLedger(client, {
    wallet,
    type,
    direction: "credit",
    amountMicros,
    balanceBeforeMicros: wallet.balanceMicros,
    balanceAfterMicros,
    workspaceId: input.workspaceId,
    workspaceLedgerId: input.workspaceLedgerId,
    serviceRequestId: input.serviceRequestId,
    incomeRecordId: input.incomeRecordId,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    description: input.description,
    metadata: input.metadata,
    operatorUserId: input.operatorUserId,
  });
  return { wallet: updated, ledger, idempotent: false };
}

export async function applyAccountWalletDebit(client: AccountWalletDb, input: AccountWalletOperationInput) {
  const userId = assertUserId(input.userId);
  const type = normalizeLedgerType(input.type || "allocate_to_workspace");
  const existing = await findIdempotentLedger(client, userId, type, input.idempotencyKey);
  if (existing) {
    return { wallet: await ensureAccountWallet(client, userId, existing.currency), ledger: existing, idempotent: true };
  }

  const amountMicros = assertPositiveAmount(Number(input.amountMicros || 0));
  const wallet = await ensureAccountWallet(client, userId, input.currency || "GU");
  if (wallet.status !== "active") throw new Error("账号钱包不可用");
  if (wallet.balanceMicros < amountMicros) throw new Error("账号 GU 余额不足");
  const balanceAfterMicros = wallet.balanceMicros - amountMicros;
  const updated = await updateWalletBalance(client, wallet, balanceAfterMicros);
  const ledger = await insertWalletLedger(client, {
    wallet,
    type,
    direction: "debit",
    amountMicros,
    balanceBeforeMicros: wallet.balanceMicros,
    balanceAfterMicros,
    workspaceId: input.workspaceId,
    workspaceLedgerId: input.workspaceLedgerId,
    serviceRequestId: input.serviceRequestId,
    incomeRecordId: input.incomeRecordId,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    description: input.description,
    metadata: input.metadata,
    operatorUserId: input.operatorUserId,
  });
  return { wallet: updated, ledger, idempotent: false };
}

export function accountWalletAvailable(wallet: AccountWallet) {
  const giftAvailableMicros = Math.max(0, wallet.giftBalanceMicros - wallet.giftReservedMicros);
  const cashAvailableMicros = Math.max(0, wallet.balanceMicros - wallet.cashReservedMicros);
  const creditAvailableMicros = Math.max(0, wallet.creditLimitMicros - wallet.creditUsedMicros - wallet.creditReservedMicros);
  return {
    giftAvailableMicros,
    cashAvailableMicros,
    creditAvailableMicros,
    totalAvailableMicros: giftAvailableMicros + cashAvailableMicros + creditAvailableMicros,
  };
}

export async function listActiveGiftGrants(client: AccountWalletDb, userId: number, at = now()): Promise<AccountGiftGrant[]> {
  await ensureAccountWalletTables(client);
  const rows = await table(client, "o_account_gift_grant")
    .where({ userId: assertUserId(userId), status: "active" })
    .andWhere("remainingMicros", ">", 0)
    .andWhere((builder) => {
      builder.whereNull("expiresAt").orWhere("expiresAt", ">", at);
    })
    .orderByRaw("?? IS NULL ASC", ["expiresAt"])
    .orderBy("expiresAt", "asc")
    .orderBy("createdAt", "asc");
  return rows.map(formatAccountGiftGrant);
}

export async function grantAccountGiftInTransaction(
  client: AccountWalletDb,
  input: AccountWalletOperationInput & { expiresAt?: number | null; campaignName?: string | null },
) {
  const userId = assertUserId(input.userId);
  const amountMicros = assertPositiveAmount(Number(input.amountMicros || 0));
  const existing = await findIdempotentLedger(client, userId, "gift_grant", input.idempotencyKey);
  if (existing) {
    assertIdempotentCreditMatches(existing, { ...input, type: "gift_grant" }, amountMicros);
    const giftGrantId = String(existing.metadata.giftGrantId || "").trim();
    const grantRow = giftGrantId
      ? await table(client, "o_account_gift_grant").where({ id: giftGrantId, userId }).first()
      : null;
    if (!grantRow) throw new Error("赠送 GU 幂等流水缺少对应批次");
    return {
      wallet: await ensureAccountWallet(client, userId, existing.currency),
      grant: formatAccountGiftGrant(grantRow),
      ledger: existing,
      idempotent: true,
    };
  }

  const wallet = await ensureAccountWallet(client, userId, input.currency || "GU");
  if (wallet.status !== "active") throw new Error("账号钱包不可用");
  const timestamp = now();
  const grantRow = {
    id: uuid(),
    userId,
    currency: normalizeCurrency(input.currency || wallet.currency),
    amountMicros,
    remainingMicros: amountMicros,
    reservedMicros: 0,
    expiresAt: input.expiresAt ?? null,
    status: "active",
    campaignName: cleanText(input.campaignName),
    description: cleanText(input.description),
    metadata: stringifyJson(input.metadata || {}),
    operatorUserId: input.operatorUserId ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await table(client, "o_account_gift_grant").insert(grantRow);
  const updated = await updateWalletFields(client, wallet, { giftBalanceMicros: wallet.giftBalanceMicros + amountMicros });
  const ledger = await insertWalletLedger(client, {
    wallet,
    type: "gift_grant",
    direction: "credit",
    amountMicros,
    balanceBeforeMicros: wallet.balanceMicros,
    balanceAfterMicros: wallet.balanceMicros,
    workspaceId: input.workspaceId,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    description: input.description || "管理员发放赠送 GU",
    metadata: { ...(input.metadata || {}), giftGrantId: grantRow.id, expiresAt: input.expiresAt ?? null, campaignName: input.campaignName || null },
    operatorUserId: input.operatorUserId,
  });
  return { wallet: updated, grant: formatAccountGiftGrant(grantRow), ledger, idempotent: false };
}

export async function grantAccountGift(input: AccountWalletOperationInput & { expiresAt?: number | null; campaignName?: string | null }) {
  return await db.transaction((trx) => grantAccountGiftInTransaction(trx, input));
}

export async function setAccountCreditLimitInTransaction(
  client: AccountWalletDb,
  input: AccountWalletOperationInput & { creditLimitMicros: number },
) {
    const userId = assertUserId(input.userId);
    const creditLimitMicros = Number(input.creditLimitMicros || 0);
    if (!Number.isSafeInteger(creditLimitMicros) || creditLimitMicros < 0) throw new Error("授信额度必须是非负整数 micros");
    const existing = await findIdempotentLedger(client, userId, "credit_set", input.idempotencyKey);
    if (existing) {
      const existingTarget = Number(existing.metadata.creditLimitMicros);
      if (
        existing.amountMicros !== Math.abs(creditLimitMicros - Number(existing.metadata.previousCreditLimitMicros ?? creditLimitMicros))
        || existingTarget !== creditLimitMicros
        || existing.currency !== normalizeCurrency(input.currency)
        || existing.workspaceId !== cleanText(input.workspaceId)
      ) {
        throw new Error("账号授信额度幂等键已被不同请求使用");
      }
      return {
        wallet: await ensureAccountWallet(client, userId, input.currency || "GU"),
        ledger: existing,
        idempotent: true,
      };
    }
    const wallet = await ensureAccountWallet(client, userId, input.currency || "GU");
    const updated = await updateWalletFields(client, wallet, { creditLimitMicros });
    const ledger = await insertWalletLedger(client, {
      wallet,
      type: "credit_set",
      direction: creditLimitMicros >= wallet.creditLimitMicros ? "credit" : "debit",
      amountMicros: Math.abs(creditLimitMicros - wallet.creditLimitMicros),
      balanceBeforeMicros: wallet.balanceMicros,
      balanceAfterMicros: wallet.balanceMicros,
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      description: input.description || `账号授信额度：${wallet.creditLimitMicros} -> ${creditLimitMicros}`,
      metadata: { ...(input.metadata || {}), previousCreditLimitMicros: wallet.creditLimitMicros, creditLimitMicros },
      operatorUserId: input.operatorUserId,
    });
    return { wallet: updated, ledger, idempotent: false };
}

export async function setAccountCreditLimit(input: AccountWalletOperationInput & { creditLimitMicros: number }) {
  return await db.transaction((trx) => setAccountCreditLimitInTransaction(trx, input));
}

export type AccountSpendSource = "gift" | "cash" | "credit";

export interface AccountSpendBreakdownItem {
  source: AccountSpendSource;
  amountMicros: number;
  grantId?: string | null;
  creditLotId?: string | null;
  sellerTenantId?: string | null;
}

async function reserveGiftGrants(client: AccountWalletDb, userId: number, amountMicros: number, context: AccountWalletOperationInput): Promise<AccountSpendBreakdownItem[]> {
  let remaining = amountMicros;
  const breakdown: AccountSpendBreakdownItem[] = [];
  const grants = (await listActiveGiftGrants(client, userId)).filter(grant => membershipGrantApplies(grant.metadata, context));
  for (const grant of grants) {
    if (remaining <= 0) break;
    const available = Math.max(0, grant.remainingMicros - grant.reservedMicros);
    if (available <= 0) continue;
    const used = Math.min(remaining, available);
    const affected = await table(client, "o_account_gift_grant")
      .where({ id: grant.id })
      .andWhere({ remainingMicros: grant.remainingMicros, reservedMicros: grant.reservedMicros, status: grant.status })
      .update({ reservedMicros: grant.reservedMicros + used, updatedAt: now() });
    if (Number(affected || 0) !== 1) throw new Error("赠送 GU 批次已变化，请重试");
    breakdown.push({ source: "gift", amountMicros: used, grantId: grant.id });
    remaining -= used;
  }
  if (remaining > 0) {
    // Gift-grant expiry is swept asynchronously.  During that small window the
    // wallet aggregate can still advertise the expired amount even though it
    // is no longer spendable.  This is a deterministic insufficient-funds
    // rejection, not a wallet-consistency failure and certainly not an
    // uncertain provider dispatch.  Preserve generic consistency errors when
    // no expired grant explains the aggregate mismatch.
    const expiredRows = await table(client, "o_account_gift_grant")
      .where({ userId, status: "active" })
      .andWhere("remainingMicros", ">", 0)
      .whereNotNull("expiresAt")
      .andWhere("expiresAt", "<=", now())
      .select("remainingMicros", "reservedMicros");
    const expiredAvailableMicros = expiredRows.reduce(
      (sum: number, row: { remainingMicros?: unknown; reservedMicros?: unknown }) => (
        sum + Math.max(0, Number(row.remainingMicros || 0) - Number(row.reservedMicros || 0))
      ),
      0,
    );
    if (expiredAvailableMicros > 0) {
      throw new AccountWalletInsufficientFundsError("账号可用额度不足", {
        requiredMicros: amountMicros,
        availableMicros: amountMicros - remaining,
      });
    }
    throw new Error("赠送 GU 可用余额不足");
  }
  return breakdown;
}

export async function reserveOwnerAccountSpend(
  client: AccountWalletDb,
  input: AccountWalletOperationInput,
): Promise<{ wallet: AccountWallet; ledger: AccountWalletLedger; breakdown: AccountSpendBreakdownItem[]; idempotent: boolean }> {
  const userId = assertUserId(input.userId);
  const existing = await findIdempotentLedger(client, userId, "spend_reserve", input.idempotencyKey);
  if (existing) {
    return {
      wallet: await ensureAccountWallet(client, userId, existing.currency),
      ledger: existing,
      breakdown: (parseJsonObject(existing.metadata).breakdown as AccountSpendBreakdownItem[]) || [],
      idempotent: true,
    };
  }
  const amountMicros = assertPositiveAmount(Number(input.amountMicros || 0));
  await ensureAccountWallet(client, userId, input.currency || "GU");
  // Billing reservations for one owner may arrive concurrently (for example a
  // multi-select image batch). Serialize them before reading the balance so a
  // sibling reservation cannot make this request fail the optimistic update
  // even though both transactions are otherwise valid.
  let walletQuery = table(client, "o_account_wallet").where({ userId });
  if ((client as Knex.Transaction).isTransaction && isPostgresClient(client)) {
    walletQuery = walletQuery.forUpdate();
  }
  const walletRow = await walletQuery.first();
  if (!walletRow) throw new Error("账户钱包不存在");
  const wallet = formatAccountWallet(walletRow);
  const available = accountWalletAvailable(wallet);
  const eligibleGrants = (await listActiveGiftGrants(client, userId)).filter(grant => membershipGrantApplies(grant.metadata, input));
  available.giftAvailableMicros = eligibleGrants.reduce((sum, grant) => sum + Math.max(0, grant.remainingMicros - grant.reservedMicros), 0);
  available.totalAvailableMicros = available.giftAvailableMicros + available.cashAvailableMicros + available.creditAvailableMicros;
  if (available.totalAvailableMicros < amountMicros) {
    throw new AccountWalletInsufficientFundsError("账号可用额度不足", {
      requiredMicros: amountMicros,
      availableMicros: available.totalAvailableMicros,
    });
  }

  let remaining = amountMicros;
  const breakdown: AccountSpendBreakdownItem[] = [];
  const giftToReserve = Math.min(remaining, available.giftAvailableMicros);
  if (giftToReserve > 0) {
    breakdown.push(...(await reserveGiftGrants(client, userId, giftToReserve, input)));
    remaining -= giftToReserve;
  }
  const cashToReserve = Math.min(remaining, available.cashAvailableMicros);
  if (cashToReserve > 0) {
    const cashAllocations = await reserveCommercialCreditLots(client, {
      userId,
      amountMicros: cashToReserve,
      cashAvailableMicros: available.cashAvailableMicros,
    });
    breakdown.push(...cashAllocations.map((item) => ({ source: "cash" as const, ...item })));
    remaining -= cashToReserve;
  }
  const creditToReserve = Math.min(remaining, available.creditAvailableMicros);
  if (creditToReserve > 0) {
    breakdown.push({ source: "credit", amountMicros: creditToReserve });
    remaining -= creditToReserve;
  }
  if (remaining > 0) {
    throw new AccountWalletInsufficientFundsError("账号可用额度不足", {
      requiredMicros: amountMicros,
      availableMicros: available.totalAvailableMicros,
    });
  }

  const updated = await updateWalletFields(client, wallet, {
    giftReservedMicros: wallet.giftReservedMicros + giftToReserve,
    cashReservedMicros: wallet.cashReservedMicros + cashToReserve,
    creditReservedMicros: wallet.creditReservedMicros + creditToReserve,
  });
  const ledger = await insertWalletLedger(client, {
    wallet,
    type: "spend_reserve",
    direction: "debit",
    amountMicros,
    balanceBeforeMicros: wallet.balanceMicros,
    balanceAfterMicros: wallet.balanceMicros,
    workspaceId: input.workspaceId,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    description: input.description || "账号额度冻结",
    metadata: { ...(input.metadata || {}), breakdown },
    operatorUserId: input.operatorUserId,
  });
  return { wallet: updated, ledger, breakdown, idempotent: false };
}

export async function captureOwnerAccountSpend(
  client: AccountWalletDb,
  input: AccountWalletOperationInput & { breakdown?: AccountSpendBreakdownItem[] },
): Promise<{ wallet: AccountWallet; ledger: AccountWalletLedger; breakdown: AccountSpendBreakdownItem[]; idempotent: boolean }> {
  const userId = assertUserId(input.userId);
  const existing = await findIdempotentLedger(client, userId, "spend_capture", input.idempotencyKey);
  if (existing) {
    return {
      wallet: await ensureAccountWallet(client, userId, existing.currency),
      ledger: existing,
      breakdown: (parseJsonObject(existing.metadata).breakdown as AccountSpendBreakdownItem[]) || [],
      idempotent: true,
    };
  }
  const amountMicros = assertPositiveAmount(Number(input.amountMicros || 0));
  const wallet = await ensureAccountWallet(client, userId, input.currency || "GU");
  const breakdown = input.breakdown || [];
  const giftMicros = breakdown.filter((item) => item.source === "gift").reduce((sum, item) => sum + item.amountMicros, 0);
  const cashMicros = breakdown.filter((item) => item.source === "cash").reduce((sum, item) => sum + item.amountMicros, 0);
  const creditMicros = breakdown.filter((item) => item.source === "credit").reduce((sum, item) => sum + item.amountMicros, 0);
  if (giftMicros + cashMicros + creditMicros !== amountMicros) throw new Error("账号扣费来源拆分不匹配");

  for (const item of breakdown.filter((entry) => entry.source === "gift")) {
    const grant = await table(client, "o_account_gift_grant").where({ id: item.grantId, userId }).first();
    if (!grant) throw new Error("赠送 GU 批次不存在");
    const current = formatAccountGiftGrant(grant);
    if (current.reservedMicros < item.amountMicros || current.remainingMicros < item.amountMicros) throw new Error("赠送 GU 冻结余额不足");
    const updated = await table(client, "o_account_gift_grant")
      .where({ id: current.id })
      .andWhere({ remainingMicros: current.remainingMicros, reservedMicros: current.reservedMicros })
      .update({
        remainingMicros: current.remainingMicros - item.amountMicros,
        reservedMicros: current.reservedMicros - item.amountMicros,
        status: current.remainingMicros - item.amountMicros <= 0 ? "exhausted" : current.status,
        updatedAt: now(),
      });
    if (updated === 0) throw new Error("赠送 GU 批次已被修改，请重试");
  }
  await captureCommercialCreditLots(
    client,
    userId,
    breakdown.filter((entry) => entry.source === "cash"),
  );
  const updated = await updateWalletFields(client, wallet, {
    giftBalanceMicros: wallet.giftBalanceMicros - giftMicros,
    giftReservedMicros: wallet.giftReservedMicros - giftMicros,
    balanceMicros: wallet.balanceMicros - cashMicros,
    cashReservedMicros: wallet.cashReservedMicros - cashMicros,
    creditReservedMicros: wallet.creditReservedMicros - creditMicros,
    creditUsedMicros: wallet.creditUsedMicros + creditMicros,
  });
  const ledger = await insertWalletLedger(client, {
    wallet,
    type: "spend_capture",
    direction: "debit",
    amountMicros,
    balanceBeforeMicros: wallet.balanceMicros,
    balanceAfterMicros: wallet.balanceMicros - cashMicros,
    workspaceId: input.workspaceId,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    description: input.description || "账号额度扣费",
    metadata: { ...(input.metadata || {}), breakdown },
    operatorUserId: input.operatorUserId,
  });
  return { wallet: updated, ledger, breakdown, idempotent: false };
}

export async function listAccountGiftGrants(input: {
  userId?: number | null;
  status?: string | null;
  expiringBefore?: number | null;
  pageNum?: number;
  pageSize?: number;
} = {}) {
  await ensureAccountWalletTables();
  const pageNum = Math.max(1, Math.min(Number(input.pageNum || 1), 500));
  const pageSize = Math.max(1, Math.min(Number(input.pageSize || 20), 500));
  const query = table(db, "o_account_gift_grant");
  if (input.userId) query.where({ userId: assertUserId(input.userId) });
  if (input.status && input.status !== "all") query.where({ status: input.status });
  if (input.expiringBefore) {
    query.where({ status: "active" }).whereNotNull("expiresAt").andWhere("expiresAt", "<=", Number(input.expiringBefore));
  }
  const countRow = await query.clone().count<{ total: number }[]>({ total: "*" }).first();
  const rows = await query.clone().orderBy("createdAt", "desc").limit(pageSize).offset((pageNum - 1) * pageSize);
  return { items: rows.map(formatAccountGiftGrant), total: Number((countRow as any)?.total || 0), pageNum, pageSize };
}

export async function expireAccountGiftGrants(input: { userId?: number | null; at?: number; operatorUserId?: number | null } = {}) {
  return await db.transaction(async (trx) => {
    await ensureAccountWalletTables(trx);
    const at = Number(input.at || now());
    const query = table(trx, "o_account_gift_grant")
      .where({ status: "active" })
      .whereNotNull("expiresAt")
      .andWhere("expiresAt", "<=", at)
      .andWhere("reservedMicros", 0)
      .andWhere("remainingMicros", ">", 0);
    if (input.userId) query.andWhere({ userId: assertUserId(input.userId) });
    const rows = await query.orderBy("expiresAt", "asc");
    const results: Array<{ grant: AccountGiftGrant; wallet: AccountWallet; ledger: AccountWalletLedger }> = [];
    for (const row of rows) {
      const grant = formatAccountGiftGrant(row);
      const wallet = await ensureAccountWallet(trx, grant.userId, grant.currency);
      const expiredMicros = Math.min(grant.remainingMicros, wallet.giftBalanceMicros);
      if (expiredMicros <= 0) continue;
      await table(trx, "o_account_gift_grant").where({ id: grant.id }).update({
        remainingMicros: 0,
        status: "expired",
        updatedAt: now(),
      });
      const updated = await updateWalletFields(trx, wallet, { giftBalanceMicros: wallet.giftBalanceMicros - expiredMicros });
      const ledger = await insertWalletLedger(trx, {
        wallet,
        type: "gift_expire",
        direction: "debit",
        amountMicros: expiredMicros,
        balanceBeforeMicros: wallet.balanceMicros,
        balanceAfterMicros: wallet.balanceMicros,
        description: "赠送 GU 到期清零",
        metadata: { giftGrantId: grant.id, expiresAt: grant.expiresAt, campaignName: grant.campaignName },
        operatorUserId: input.operatorUserId ?? null,
      });
      results.push({ grant: { ...grant, remainingMicros: 0, status: "expired", updatedAt: now() }, wallet: updated, ledger });
    }
    return { expiredCount: results.length, items: results };
  });
}

export async function revokeAccountGiftGrant(input: { id: string; description?: string | null; operatorUserId?: number | null }) {
  return await db.transaction(async (trx) => {
    await ensureAccountWalletTables(trx);
    const row = await table(trx, "o_account_gift_grant").where({ id: cleanText(input.id) }).first();
    if (!row) throw new Error("赠送 GU 批次不存在");
    const grant = formatAccountGiftGrant(row);
    if (grant.status !== "active") throw new Error("只能撤销 active 状态的赠送 GU");
    if (grant.reservedMicros > 0) throw new Error("赠送 GU 存在冻结额度，无法撤销");
    const wallet = await ensureAccountWallet(trx, grant.userId, grant.currency);
    const revokedMicros = Math.min(grant.remainingMicros, wallet.giftBalanceMicros);
    await table(trx, "o_account_gift_grant").where({ id: grant.id }).update({
      remainingMicros: 0,
      status: "revoked",
      updatedAt: now(),
    });
    const updated = await updateWalletFields(trx, wallet, { giftBalanceMicros: wallet.giftBalanceMicros - revokedMicros });
    const ledger = await insertWalletLedger(trx, {
      wallet,
      type: "gift_revoke",
      direction: "debit",
      amountMicros: revokedMicros,
      balanceBeforeMicros: wallet.balanceMicros,
      balanceAfterMicros: wallet.balanceMicros,
      description: input.description || "撤销赠送 GU",
      metadata: { giftGrantId: grant.id, campaignName: grant.campaignName, expiresAt: grant.expiresAt },
      operatorUserId: input.operatorUserId ?? null,
    });
    return { grant: { ...grant, remainingMicros: 0, status: "revoked", updatedAt: now() }, wallet: updated, ledger };
  });
}

export class AccountGiftRefundError extends Error {
  readonly status = 409;
  readonly code = "PAYMENT_GIFT_NOT_REFUNDABLE";
}

/** Order-scoped gift refund, called while holding the wallet lock in the principal-refund transaction. */
export async function refundOrderGiftInTransaction(client: AccountWalletDb, input: {
  userId: number; grantId: string; orderId: string; phase: "reserve" | "release" | "finalize";
}) {
  const wallet = await ensureAccountWallet(client, input.userId, "GU");
  const row = await table(client, "o_account_gift_grant").where({ id: input.grantId, userId: input.userId }).forUpdate().first();
  if (!row) throw new AccountGiftRefundError("会员赠分批次不存在，退款需核对");
  const grant = formatAccountGiftGrant(row);
  if (grant.metadata.paymentOrderId !== input.orderId) throw new AccountGiftRefundError("会员赠分与退款订单不匹配");
  if (input.phase === "reserve" && (grant.status !== "active" || grant.remainingMicros !== grant.amountMicros || grant.reservedMicros !== 0)) throw new AccountGiftRefundError("会员赠分已使用或到期，请通过财务处理退款");
  if (input.phase !== "reserve" && (grant.status !== "active" || grant.remainingMicros !== grant.amountMicros || grant.reservedMicros !== grant.amountMicros)) throw new AccountGiftRefundError("会员赠分退款占用证据不一致");
  const amount = grant.amountMicros;
  const delta = input.phase === "reserve" ? amount : -amount;
  if (wallet.giftReservedMicros + delta < 0 || wallet.giftBalanceMicros < amount || !Number.isSafeInteger(wallet.giftReservedMicros + delta)) throw new AccountGiftRefundError("会员赠分冻结金额不一致");
  await updateWalletFields(client, wallet, {
    giftReservedMicros: wallet.giftReservedMicros + delta,
    ...(input.phase === "finalize" ? { giftBalanceMicros: wallet.giftBalanceMicros - amount } : {}),
  });
  await table(client, "o_account_gift_grant").where({ id: grant.id }).update({
    reservedMicros: input.phase === "reserve" ? amount : 0,
    ...(input.phase === "finalize" ? { remainingMicros: 0, status: "revoked" } : {}), updatedAt: now(),
  });
  if (input.phase === "finalize") await insertWalletLedger(client, {
    wallet, type: "gift_revoke", direction: "debit", amountMicros: amount,
    balanceBeforeMicros: wallet.balanceMicros, balanceAfterMicros: wallet.balanceMicros,
    idempotencyKey: grant.metadata.membership ? `online-payment-refund-gift:${input.orderId}:${input.grantId}` : `online-payment-refund-gift:${input.orderId}`,
    description: "会员订单退款，退回对应赠送积分",
    metadata: { giftGrantId: grant.id, paymentOrderId: input.orderId },
  });
}

export async function releaseOwnerAccountSpend(
  client: AccountWalletDb,
  input: AccountWalletOperationInput & { breakdown?: AccountSpendBreakdownItem[] },
): Promise<{ wallet: AccountWallet; ledger: AccountWalletLedger; breakdown: AccountSpendBreakdownItem[]; idempotent: boolean }> {
  const userId = assertUserId(input.userId);
  const existing = await findIdempotentLedger(client, userId, "spend_release", input.idempotencyKey);
  if (existing) {
    return {
      wallet: await ensureAccountWallet(client, userId, existing.currency),
      ledger: existing,
      breakdown: (parseJsonObject(existing.metadata).breakdown as AccountSpendBreakdownItem[]) || [],
      idempotent: true,
    };
  }
  const amountMicros = assertPositiveAmount(Number(input.amountMicros || 0));
  const wallet = await ensureAccountWallet(client, userId, input.currency || "GU");
  const breakdown = input.breakdown || [];
  const giftMicros = breakdown.filter((item) => item.source === "gift").reduce((sum, item) => sum + item.amountMicros, 0);
  const cashMicros = breakdown.filter((item) => item.source === "cash").reduce((sum, item) => sum + item.amountMicros, 0);
  const creditMicros = breakdown.filter((item) => item.source === "credit").reduce((sum, item) => sum + item.amountMicros, 0);
  if (giftMicros + cashMicros + creditMicros !== amountMicros) throw new Error("账号释放来源拆分不匹配");
  if (
    wallet.giftReservedMicros < giftMicros
    || wallet.cashReservedMicros < cashMicros
    || wallet.creditReservedMicros < creditMicros
  ) {
    throw new Error("账号钱包冻结来源不足，禁止释放");
  }

  for (const item of breakdown.filter((entry) => entry.source === "gift")) {
    const grant = await table(client, "o_account_gift_grant").where({ id: item.grantId, userId }).first();
    if (!grant) throw new Error("赠送 GU 批次不存在");
    const current = formatAccountGiftGrant(grant);
    if (current.reservedMicros < item.amountMicros) throw new Error("赠送 GU 冻结余额不足");
    const updated = await table(client, "o_account_gift_grant")
      .where({ id: current.id })
      .andWhere({ reservedMicros: current.reservedMicros })
      .update({
        reservedMicros: current.reservedMicros - item.amountMicros,
        updatedAt: now(),
      });
    if (updated === 0) throw new Error("赠送 GU 批次已被修改，请重试");
  }
  await releaseCommercialCreditLots(
    client,
    userId,
    breakdown.filter((entry) => entry.source === "cash"),
  );
  const updated = await updateWalletFields(client, wallet, {
    giftReservedMicros: wallet.giftReservedMicros - giftMicros,
    cashReservedMicros: wallet.cashReservedMicros - cashMicros,
    creditReservedMicros: wallet.creditReservedMicros - creditMicros,
  });
  const ledger = await insertWalletLedger(client, {
    wallet,
    type: "spend_release",
    direction: "credit",
    amountMicros,
    balanceBeforeMicros: wallet.balanceMicros,
    balanceAfterMicros: wallet.balanceMicros,
    workspaceId: input.workspaceId,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    description: input.description || "账号冻结额度释放",
    metadata: { ...(input.metadata || {}), breakdown },
    operatorUserId: input.operatorUserId,
  });
  return { wallet: updated, ledger, breakdown, idempotent: false };
}

export async function creditAccountWallet(input: AccountWalletOperationInput) {
  try {
    return await db.transaction(async (trx) => applyAccountWalletCredit(trx, input));
  } catch (error) {
    if (!cleanText(input.idempotencyKey)) throw error;
    const userId = assertUserId(input.userId);
    const type = normalizeLedgerType(input.type || "recharge");
    const amountMicros = assertPositiveAmount(Number(input.amountMicros || 0));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const existing = await findIdempotentLedger(db, userId, type, input.idempotencyKey);
        if (existing) {
          assertIdempotentCreditMatches(existing, input, amountMicros);
          return { wallet: await ensureAccountWallet(db, userId, existing.currency), ledger: existing, idempotent: true };
        }
      } catch (replayError) {
        if (replayError instanceof Error && /幂等键已被不同/.test(replayError.message)) throw replayError;
      }
      if (attempt + 1 < 6) await new Promise((resolve) => setTimeout(resolve, 5 * 2 ** attempt));
    }
    throw error;
  }
}

export async function debitAccountWallet(input: AccountWalletOperationInput) {
  return await db.transaction(async (trx) => applyAccountWalletDebit(trx, input));
}

export async function getAccountWallet(userId: number, options: { autoCreate?: boolean; currency?: string } = {}) {
  await ensureAccountWalletTables();
  const wallet = await readAccountWallet(db, userId);
  if (wallet || options.autoCreate === false) return wallet;
  return await ensureAccountWallet(db, userId, options.currency || "GU");
}

export async function listAccountWalletLedger(input: {
  userId: number;
  type?: AccountWalletLedgerType | null;
  workspaceId?: string | null;
  pageNum?: number;
  pageSize?: number;
}) {
  await ensureAccountWalletTables();
  const userId = assertUserId(input.userId);
  const pageNum = Math.max(1, Math.min(Number(input.pageNum || 1), 500));
  const pageSize = Math.max(1, Math.min(Number(input.pageSize || 20), 500));
  const query = table(db, "o_account_wallet_ledger").where({ userId });
  if (input.type) query.andWhere({ type: input.type });
  if (input.workspaceId) query.andWhere({ workspaceId: input.workspaceId });
  const countRow = await query.clone().count<{ total: number }[]>({ total: "*" }).first();
  const rows = await query
    .clone()
    .orderBy("createdAt", "desc")
    .limit(pageSize)
    .offset((pageNum - 1) * pageSize);
  return {
    items: rows.map(formatAccountWalletLedger),
    total: Number((countRow as any)?.total || 0),
    pageNum,
    pageSize,
  };
}

export async function linkAccountWalletLedgerToWorkspaceLedger(client: AccountWalletDb, accountWalletLedgerId: string, workspaceLedgerId: string) {
  await ensureAccountWalletTables(client);
  await table(client, "o_account_wallet_ledger")
    .where({ id: accountWalletLedgerId })
    .update({ workspaceLedgerId, updatedAt: now() });
}

export async function linkAccountWalletLedgerToIncomeRecord(client: AccountWalletDb, accountWalletLedgerId: string, incomeRecordId: string) {
  await ensureAccountWalletTables(client);
  await table(client, "o_account_wallet_ledger")
    .where({ id: accountWalletLedgerId })
    .update({ incomeRecordId, updatedAt: now() });
}
