import { GU_MICROS_PER_GU } from "@/utils/billingUnits";
export type BillingPlanStatus = "active" | "archived";

export interface BillingPlan {
  id: string;
  code?: string | null;
  name?: string | null;
  currency?: string | null;
  monthlyFeeMicros?: number | null;
  includedCreditsMicros?: number | null;
  apiQuota?: number | null;
  memberLimit?: number | null;
  keyLimit?: number | null;
  status?: BillingPlanStatus | string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | number | null;
  updatedAt?: string | number | null;
}

export interface BillingPlanForm {
  id: string;
  code: string;
  name: string;
  monthlyFee: number;
  includedCredits: number;
  apiQuota: number | null;
  memberLimit: number | null;
  keyLimit: number | null;
  status: BillingPlanStatus;
}

export interface BillingPlanPayload {
  code: string;
  name: string;
  currency: "GU";
  monthlyFeeMicros: number;
  includedCreditsMicros: number;
  apiQuota: number | null;
  memberLimit: number | null;
  keyLimit: number | null;
  status: BillingPlanStatus;
}

export function createEmptyPlanForm(): BillingPlanForm {
  return {
    id: "",
    code: "",
    name: "",
    monthlyFee: 0,
    includedCredits: 0,
    apiQuota: null,
    memberLimit: null,
    keyLimit: null,
    status: "active",
  };
}

function microsToGu(value?: number | null) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number >= 0 ? number / GU_MICROS_PER_GU : 0;
}

export function planFormFromPlan(plan: BillingPlan): BillingPlanForm {
  return {
    id: String(plan.id || ""),
    code: String(plan.code || ""),
    name: String(plan.name || ""),
    monthlyFee: microsToGu(plan.monthlyFeeMicros),
    includedCredits: microsToGu(plan.includedCreditsMicros),
    apiQuota: plan.apiQuota == null ? null : Number(plan.apiQuota),
    memberLimit: plan.memberLimit == null ? null : Number(plan.memberLimit),
    keyLimit: plan.keyLimit == null ? null : Number(plan.keyLimit),
    status: plan.status === "archived" ? "archived" : "active",
  };
}

function guToMicros(value: number) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value * GU_MICROS_PER_GU) : 0;
}

function validateOptionalLimit(value: number | null, label: string) {
  if (value === null) return;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label}必须是非负整数或留空`);
}

export function buildPlanPayload(form: BillingPlanForm): BillingPlanPayload {
  if (!form.code.trim()) throw new Error("请填写套餐标识");
  if (!form.name.trim()) throw new Error("请填写套餐名称");
  if (!Number.isFinite(form.monthlyFee) || form.monthlyFee < 0) throw new Error("月费必须是非负数");
  if (!Number.isFinite(form.includedCredits) || form.includedCredits < 0) throw new Error("包含额度必须是非负数");
  validateOptionalLimit(form.apiQuota, "API 配额");
  validateOptionalLimit(form.memberLimit, "成员上限");
  validateOptionalLimit(form.keyLimit, "密钥上限");
  return {
    code: form.code.trim(),
    name: form.name.trim(),
    currency: "GU",
    monthlyFeeMicros: guToMicros(form.monthlyFee),
    includedCreditsMicros: guToMicros(form.includedCredits),
    apiQuota: form.apiQuota,
    memberLimit: form.memberLimit,
    keyLimit: form.keyLimit,
    status: form.status,
  };
}
