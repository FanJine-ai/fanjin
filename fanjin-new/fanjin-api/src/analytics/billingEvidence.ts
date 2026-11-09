import { createHash } from "node:crypto";
import { guAmount, ledgerAmount } from "@/tools/contracts";

const object = (raw: unknown): Record<string, any> => {
  try { const value = typeof raw === "string" ? JSON.parse(raw) : raw; return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; }
};
const micros = (raw: unknown) => {
  if (typeof raw !== "number" && typeof raw !== "string" || !/^\d+$/.test(String(raw))) return null;
  try { return ledgerAmount(raw); } catch { return null; }
};

// Only historical customer-facing facts leave the billing boundary. Never return
// raw metadata, provider pricing, current mutable rules or grant/payment IDs.
export function customerBillingEvidence(rows: Array<Record<string, any>>) {
  let pricing: Record<string, any> | null = null;
  for (const row of [...rows].reverse()) {
    const snapshot = object(object(row.metadata).priceSnapshot);
    const unitPrice = micros(snapshot.unitPriceMicros);
    if (unitPrice == null || snapshot.currency !== "GU" || !["second", "image", "token", "task", "request"].includes(snapshot.unit)) continue;
    const fields = { unit: snapshot.unit, unitPrice: guAmount(unitPrice), multiplier: typeof snapshot.multiplier === "number" && Number.isFinite(snapshot.multiplier) && snapshot.multiplier >= 0 ? snapshot.multiplier : null,
      updatedAt: Number.isSafeInteger(snapshot.pricingRuleUpdatedAt) && snapshot.pricingRuleUpdatedAt > 0 ? snapshot.pricingRuleUpdatedAt : null };
    pricing = { ...fields, snapshotId: createHash("sha256").update(JSON.stringify(fields)).digest("hex").slice(0, 16) };
    break;
  }
  const funding = rows.filter(row => ["deduct", "refund", "spend_capture", "spend_reserve", "spend_release", "freeze", "release"].includes(row.type)).map(row => {
    const meta = object(row.metadata);
    const raw = meta.ownerSpendBreakdown ?? meta.breakdown;
    const totals = { cash: 0n, gift: 0n, credit: 0n };
    let valid = Array.isArray(raw) && raw.length > 0;
    for (const part of Array.isArray(raw) ? raw : []) {
      const value = micros(part?.amountMicros);
      if (!part || !Object.hasOwn(totals, part.source) || value == null) { valid = false; continue; }
      totals[part.source as keyof typeof totals] += value;
    }
    const sum = Object.values(totals).reduce((a, b) => a + b, 0n);
    const known = valid && sum === micros(row.amountMicros);
    return { ledgerId: String(row.id), type: String(row.type), amount: guAmount(ledgerAmount(row.amountMicros ?? 0)), known,
      pools: known ? Object.entries(totals).filter(([, value]) => value > 0n).map(([source, value]) => ({ source, amount: guAmount(value) })) : [] };
  });
  return { pricing, funding };
}
