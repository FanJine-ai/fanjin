import { GU_MICROS_PER_GU, formatGuMicros } from "@/utils/billingUnits";
import type {
  AccountRow,
  FinanceCaseRow,
  FinanceRecord,
  GiftGrantRow,
  LedgerRow,
  PagePayload,
} from "./types";

export function unwrapPayload<T>(value: T | { data?: T }): T {
  return ((value as { data?: T })?.data ?? value) as T;
}

export function extractItems(value: PagePayload | FinanceRecord[] | null | undefined): FinanceRecord[] {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

export function displayValue(value: unknown) {
  return value === null || value === undefined || value === "" ? "-" : String(value);
}

export function formatGu(micros?: number | string | null, rounding: "up" | "down" = "up") {
  const value = Number(micros || 0);
  if (!Number.isFinite(value)) return "0 GU";
  return formatGuMicros(micros, 2, rounding);
}

export function formatCny(micros?: number | string | null) {
  const value = Number(micros || 0);
  if (!Number.isFinite(value)) return "¥0.00";
  return `¥${(value / 1_000_000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatDate(value?: number | string | null) {
  if (!value) return "-";
  const numeric = Number(value);
  const date = new Date(Number.isFinite(numeric) ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric) : value);
  if (Number.isNaN(date.getTime())) return "-";
  const part = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}`;
}

export function dateInputToMillis(value: string) {
  if (!value.trim()) return null;
  const time = new Date(`${value.trim()}T23:59:59`).getTime();
  return Number.isFinite(time) ? time : null;
}

/** Parse a decimal currency value without passing through binary floating point. */
export function decimalToMicros(value: string, currency: "CNY" | "GU" = "CNY") {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) return null;
  try {
    const decimalMicros = BigInt(match[1]) * 1_000_000n + BigInt((match[2] || "").padEnd(6, "0"));
    const micros = currency === "GU" ? decimalMicros * BigInt(GU_MICROS_PER_GU / 1_000_000) : decimalMicros;
    if (micros > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(micros);
  } catch {
    return null;
  }
}

export function guToMicros(value: string) {
  return decimalToMicros(value, "GU") ?? 0;
}

export function yuanToMicros(value: string) {
  return decimalToMicros(value) ?? 0;
}

export function guMicrosToYuanMicros(value: number) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value / 1000) : 0;
}

export function toAccountRows(items: FinanceRecord[]): AccountRow[] {
  return items.map((item, index) => ({
    id: String(item.id || item.workspaceId || index),
    source: item,
    workspaceId: displayValue(item.workspaceId),
    workspaceName: displayValue(item.workspaceName),
    owner: displayValue(item.ownerName || item.ownerEmail),
    available: formatGu(item.availableMicros, "down"),
    balance: formatGu(item.balanceMicros, "down"),
    credit: formatGu(item.creditLimitMicros, "down"),
    reserved: formatGu(item.reservedMicros),
    billingMode: displayValue(item.billingMode),
    status: String(item.status || "active"),
  }));
}

export function toLedgerRows(items: FinanceRecord[]): LedgerRow[] {
  return items.map((item, index) => ({
    id: String(item.id || index),
    workspace: displayValue(item.workspaceName || item.workspaceId),
    type: displayValue(item.type),
    direction: item.direction === "credit" ? "入账" : item.direction === "debit" ? "出账" : displayValue(item.direction),
    amount: formatGu(item.amountMicros),
    balance: formatGu(item.balanceAfterMicros, "down"),
    operator: displayValue(item.operatorName),
    description: displayValue(item.description),
    time: formatDate(item.createdAt),
  }));
}

export function toCaseRows(items: FinanceRecord[], typeLabels: Record<string, string>): FinanceCaseRow[] {
  return items.map((item, index) => ({
    id: String(item.id || index),
    source: item,
    caseNo: displayValue(item.caseNo),
    workspace: displayValue(item.workspaceName || item.workspaceId),
    type: typeLabels[String(item.type)] || displayValue(item.type),
    amount: formatGu(item.amountGuMicros),
    amountCny: formatCny(item.amountCnyMicros),
    submittedBy: displayValue(item.submittedByName),
    status: String(item.status || "pending"),
    time: formatDate(item.createdAt),
  }));
}

export function toGiftRows(items: FinanceRecord[]): GiftGrantRow[] {
  return items.map((item, index) => ({
    id: String(item.id || index),
    source: item,
    userId: displayValue(item.userId),
    workspace: displayValue(item.workspaceName || item.workspaceId),
    amount: formatGu(item.amountMicros),
    remaining: formatGu(item.remainingMicros, "down"),
    campaign: displayValue(item.campaignName),
    status: String(item.status || "active"),
    expiresAt: item.expiresAt ? formatDate(item.expiresAt) : "永久",
    createdAt: formatDate(item.createdAt),
  }));
}
