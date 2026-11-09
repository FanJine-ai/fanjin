import { Knex } from "knex";
import { v4 as uuid } from "uuid";
import { db } from "@/utils/db";
import { isPostgresClient } from "@/lib/dbDialect";
import {
  type RuntimeSchemaContract,
  verifyPostgresRuntimeSchema,
} from "@/lib/runtimeSchemaVerification";

type FinanceIncomeDb = Knex | Knex.Transaction;

export const financeIncomeStatuses = ["pending", "confirmed", "refunded", "voided"] as const;
export type FinanceIncomeStatus = (typeof financeIncomeStatuses)[number];

export interface CreateFinanceIncomeRecordInput {
  workspaceId: string;
  amountMicros: number;
  channel: string;
  channelName?: string | null;
  method?: string | null;
  status?: FinanceIncomeStatus;
  ledgerId?: string | null;
  serviceRequestId?: string | null;
  tradeNo?: string | null;
  payerName?: string | null;
  subjectName?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown>;
  operatorUserId?: number | null;
  paymentTime?: number | null;
  confirmedAt?: number | null;
  idempotencyKey?: string | null;
}

export interface FinanceIncomeRecord {
  id: string;
  workspaceId: string;
  ledgerId: string | null;
  serviceRequestId: string | null;
  channel: string;
  channelName: string | null;
  method: string | null;
  status: FinanceIncomeStatus;
  amountMicros: number;
  currency: "CNY";
  tradeNo: string | null;
  payerName: string | null;
  subjectName: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  operatorUserId: number | null;
  paymentTime: number | null;
  confirmedAt: number | null;
  idempotencyKey: string | null;
  createdAt: number;
  updatedAt: number;
}

let ensurePromise: Promise<void> | null = null;
const postgresSchemaPromises = new WeakMap<object, Promise<void>>();

const financeIncomeRuntimeSchema = {
  errorCode: "FINANCE_INCOME_RUNTIME_SCHEMA_INVALID",
  label: "finance income",
  tables: [
    {
      name: "o_finance_income_record",
      columns: [
        "id", "workspaceId", "ledgerId", "serviceRequestId", "channel",
        "channelName", "method", "status", "amountMicros", "currency",
        "tradeNo", "payerName", "subjectName", "description", "metadata",
        "operatorUserId", "paymentTime", "confirmedAt", "idempotencyKey",
        "createdAt", "updatedAt",
      ],
    },
  ],
  indexes: [
    {
      name: "idx_o_finance_income_workspace_time",
      table: "o_finance_income_record",
      unique: false,
      columns: ["workspaceId", "createdAt"],
      predicate: null,
    },
    {
      name: "idx_o_finance_income_channel_time",
      table: "o_finance_income_record",
      unique: false,
      columns: ["channel", "createdAt"],
      predicate: null,
    },
    {
      name: "idx_o_finance_income_status_time",
      table: "o_finance_income_record",
      unique: false,
      columns: ["status", "createdAt"],
      predicate: null,
    },
    {
      name: "idx_o_finance_income_ledger",
      table: "o_finance_income_record",
      unique: false,
      columns: ["ledgerId"],
      predicate: null,
    },
    {
      name: "idx_o_finance_income_idempotency",
      table: "o_finance_income_record",
      unique: true,
      columns: ["idempotencyKey"],
      predicate: '"idempotencyKey" IS NOT NULL',
    },
  ],
} as const satisfies RuntimeSchemaContract;

function postgresSchemaCacheKey(client: FinanceIncomeDb): object {
  const configuredClient = (client as any)?.client;
  return configuredClient && (typeof configuredClient === "object" || typeof configuredClient === "function")
    ? configuredClient
    : (client as unknown as object);
}

async function verifyFinanceIncomeRuntimeSchema(client: FinanceIncomeDb): Promise<void> {
  const key = postgresSchemaCacheKey(client);
  let pending = postgresSchemaPromises.get(key);
  if (!pending) {
    pending = verifyPostgresRuntimeSchema(client, financeIncomeRuntimeSchema);
    postgresSchemaPromises.set(key, pending);
  }
  await pending;
}

function table(client: FinanceIncomeDb, tableName: string): Knex.QueryBuilder {
  return (client as any)(tableName);
}

function now(): number {
  return Date.now();
}

function cleanText(value?: string | null): string | null {
  const text = String(value || "").trim();
  return text || null;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? {});
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

function assertPositiveAmount(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("人民币收入金额必须是正整数 micros");
  }
  return value;
}

function normalizeStatus(value?: string | null): FinanceIncomeStatus {
  return financeIncomeStatuses.includes(value as FinanceIncomeStatus) ? (value as FinanceIncomeStatus) : "confirmed";
}

export function normalizeFinanceIncomeRecord(row: any): FinanceIncomeRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspaceId || ""),
    ledgerId: row.ledgerId || null,
    serviceRequestId: row.serviceRequestId || null,
    channel: String(row.channel || "manual"),
    channelName: row.channelName || null,
    method: row.method || null,
    status: normalizeStatus(row.status),
    amountMicros: Number(row.amountMicros || 0),
    currency: "CNY",
    tradeNo: row.tradeNo || null,
    payerName: row.payerName || null,
    subjectName: row.subjectName || null,
    description: row.description || null,
    metadata: parseJsonObject(row.metadata),
    operatorUserId: row.operatorUserId == null ? null : Number(row.operatorUserId),
    paymentTime: row.paymentTime == null ? null : Number(row.paymentTime),
    confirmedAt: row.confirmedAt == null ? null : Number(row.confirmedAt),
    idempotencyKey: row.idempotencyKey || null,
    createdAt: Number(row.createdAt || 0),
    updatedAt: Number(row.updatedAt || 0),
  };
}

export async function ensureFinanceIncomeTable(client: FinanceIncomeDb = db): Promise<void> {
  if (isPostgresClient(client)) {
    await verifyFinanceIncomeRuntimeSchema(client);
    return;
  }
  if (client !== db) {
    await ensureFinanceIncomeTable(db);
    return;
  }
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const exists = await db.schema.hasTable("o_finance_income_record");
      if (!exists) {
        await db.schema.createTable("o_finance_income_record", (table) => {
          table.text("id").notNullable();
          table.text("workspaceId").notNullable();
          table.text("ledgerId");
          table.text("serviceRequestId");
          table.text("channel").notNullable();
          table.text("channelName");
          table.text("method");
          table.text("status").notNullable().defaultTo("confirmed");
          table.bigInteger("amountMicros").notNullable().defaultTo(0);
          table.text("currency").notNullable().defaultTo("CNY");
          table.text("tradeNo");
          table.text("payerName");
          table.text("subjectName");
          table.text("description");
          table.text("metadata").notNullable().defaultTo("{}");
          table.bigInteger("operatorUserId");
          table.bigInteger("paymentTime");
          table.bigInteger("confirmedAt");
          table.text("idempotencyKey");
          table.bigInteger("createdAt").notNullable();
          table.bigInteger("updatedAt").notNullable();
          table.primary(["id"]);
        });
      }
      await db.raw("CREATE INDEX IF NOT EXISTS ?? ON ?? (??, ??)", [
        "idx_o_finance_income_workspace_time",
        "o_finance_income_record",
        "workspaceId",
        "createdAt",
      ]);
      await db.raw("CREATE INDEX IF NOT EXISTS ?? ON ?? (??, ??)", [
        "idx_o_finance_income_channel_time",
        "o_finance_income_record",
        "channel",
        "createdAt",
      ]);
      await db.raw("CREATE INDEX IF NOT EXISTS ?? ON ?? (??, ??)", [
        "idx_o_finance_income_status_time",
        "o_finance_income_record",
        "status",
        "createdAt",
      ]);
      await db.raw("CREATE INDEX IF NOT EXISTS ?? ON ?? (??)", [
        "idx_o_finance_income_ledger",
        "o_finance_income_record",
        "ledgerId",
      ]);
      await db.raw(
        "CREATE UNIQUE INDEX IF NOT EXISTS ?? ON ?? (??) WHERE ?? IS NOT NULL",
        [
          "idx_o_finance_income_idempotency",
          "o_finance_income_record",
          "idempotencyKey",
          "idempotencyKey",
        ],
      );
    })();
  }
  await ensurePromise;
}

export async function createFinanceIncomeRecord(input: CreateFinanceIncomeRecordInput, client: FinanceIncomeDb = db): Promise<FinanceIncomeRecord> {
  await ensureFinanceIncomeTable(client);
  const amountMicros = assertPositiveAmount(Number(input.amountMicros || 0));
  const idempotencyKey = cleanText(input.idempotencyKey);
  if (idempotencyKey) {
    const existing = await table(client, "o_finance_income_record").where({ idempotencyKey }).first();
    if (existing) return normalizeFinanceIncomeRecord(existing);
  }

  const timestamp = now();
  const status = normalizeStatus(input.status);
  const row = {
    id: uuid(),
    workspaceId: String(input.workspaceId || "").trim(),
    ledgerId: cleanText(input.ledgerId),
    serviceRequestId: cleanText(input.serviceRequestId),
    channel: cleanText(input.channel) || "manual",
    channelName: cleanText(input.channelName),
    method: cleanText(input.method),
    status,
    amountMicros,
    currency: "CNY",
    tradeNo: cleanText(input.tradeNo),
    payerName: cleanText(input.payerName),
    subjectName: cleanText(input.subjectName),
    description: cleanText(input.description),
    metadata: stringifyJson(input.metadata || {}),
    operatorUserId: input.operatorUserId ?? null,
    paymentTime: input.paymentTime ?? timestamp,
    confirmedAt: input.confirmedAt ?? (status === "confirmed" ? timestamp : null),
    idempotencyKey,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (!row.workspaceId) throw new Error("workspaceId 不能为空");

  await table(client, "o_finance_income_record").insert(row);
  return normalizeFinanceIncomeRecord(row);
}
