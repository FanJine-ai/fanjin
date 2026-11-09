import { GU_MICROS_PER_GU } from "@/utils/billingUnits";
export type RedemptionStatus = "unused" | "redeemed" | "disabled";
export interface RedemptionCode { id: string; code?: string | null; batchId?: string | null; amountMicros?: number | null; currency?: string | null; status?: RedemptionStatus | string | null; expiresAt?: number | null; batchNote?: string | null; redeemedBy?: string | number | null; redeemedAt?: number | null; createdBy?: string | number | null; createTime?: number | null; updateTime?: number | null; }
export interface RedemptionList { total: number; items: RedemptionCode[]; }
export interface RedemptionForm { count: number; amountGu: number; expiresAt: string; batchNote: string; }
export interface RedemptionBatch { id: string; note: string; amountMicros: number; createdAt: number | null; expiresAt: number | null; codes: RedemptionCode[]; unused: number; redeemed: number; disabled: number; }
export function emptyRedemptionForm(): RedemptionForm { return { count: 10, amountGu: 100, expiresAt: "", batchNote: "" }; }
export function toMillis(value: string) { if (!value) return null; const time = new Date(`${value}T23:59:59`).getTime(); return Number.isFinite(time) ? time : null; }
export function buildGeneratePayload(form: RedemptionForm) {
  if (!Number.isInteger(form.count) || form.count < 1 || form.count > 1000) throw new Error("生成数量必须是 1-1000 的整数");
  if (!Number.isFinite(form.amountGu) || form.amountGu <= 0) throw new Error("单张面值必须大于 0");
  const payload: Record<string, unknown> = { count: form.count, amountMicros: Math.round(form.amountGu * GU_MICROS_PER_GU) };
  const expiresAt = toMillis(form.expiresAt); if (expiresAt) payload.expiresAt = expiresAt;
  if (form.batchNote.trim()) payload.batchNote = form.batchNote.trim();
  return payload;
}
export function groupBatches(items: RedemptionCode[]): RedemptionBatch[] {
  const groups = new Map<string, RedemptionCode[]>();
  items.forEach((item, index) => { const id = String(item.batchId || `legacy-${item.id || index}`); groups.set(id, [...(groups.get(id) || []), item]); });
  return [...groups].map(([id, codes]) => ({ id, note: String(codes[0]?.batchNote || "未命名批次"), amountMicros: Number(codes[0]?.amountMicros || 0), createdAt: codes[0]?.createTime ?? null, expiresAt: codes[0]?.expiresAt ?? null, codes, unused: codes.filter((c) => c.status === "unused").length, redeemed: codes.filter((c) => c.status === "redeemed").length, disabled: codes.filter((c) => c.status === "disabled").length }));
}
