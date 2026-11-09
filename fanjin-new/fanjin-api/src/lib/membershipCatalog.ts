import crypto from "node:crypto";
import { guMicrosPerGu, cnyMicrosPerYuan } from "./billingUnits";

// Issued versions are immutable. Future prices/features get a new catalog entry,
// while parsing and fulfilling existing orders continue to use their original version.
export const MEMBERSHIP_V1_VERSION = "fanjin-membership-20260910/v1";
const MEMBERSHIP_V1_FEATURES = {
  storyboard: { level: 1, name: "脚本策划与智能分镜" },
  director: { level: 2, name: "3D 导演台" },
  analysis: { level: 2, name: "逐帧分析与成片制作" },
  workflow: { level: 3, name: "工作流保存与复用" },
  rewrite: { level: 3, name: "片段重拍" },
  shared: { level: 4, name: "团队共享与成员邀请" },
  teamBudget: { level: 5, name: "团队成员预算管理" },
  apiManagement: { level: 6, name: "API 密钥与配额管理" },
} as const;
export const MEMBERSHIP_VERSION = "fanjin-membership-20260910/v2";
export const MEMBERSHIP_FEATURES = Object.fromEntries(Object.entries(MEMBERSHIP_V1_FEATURES).map(([key, value]) => [key, { ...value, level: 0 }])) as Record<keyof typeof MEMBERSHIP_V1_FEATURES, { level: number; name: string }>;
export type MembershipFeature = keyof typeof MEMBERSHIP_FEATURES;
export type MembershipCreditScope = "seedance" | "h3";

export const MEMBERSHIP_V1_PLANS = [
  { id: "basic", name: "基础会员", priceYuan: 39, seedancePayPercent: 99, h3PayPercent: 80 },
  { id: "standard", name: "标准会员", priceYuan: 199, seedancePayPercent: 99, h3PayPercent: 75 },
  { id: "professional", name: "专业会员", priceYuan: 999, seedancePayPercent: 98, h3PayPercent: 70 },
  { id: "elite", name: "精英会员", priceYuan: 2999, seedancePayPercent: 98, h3PayPercent: 65 },
  { id: "premium", name: "尊享会员", priceYuan: 4999, seedancePayPercent: 98, h3PayPercent: 60 },
  { id: "flagship", name: "旗舰会员", priceYuan: 9999, seedancePayPercent: 98, h3PayPercent: 55 },
  { id: "ultimate", name: "至尊会员", priceYuan: 19999, seedancePayPercent: 98, h3PayPercent: 50 },
].map((plan, level) => Object.freeze({ ...plan, level,
  features: (Object.keys(MEMBERSHIP_V1_FEATURES) as MembershipFeature[]).filter(key => MEMBERSHIP_V1_FEATURES[key].level <= level),
}));
export interface MembershipLimits { seats: number; concurrentGenerations: number; storageBytes: number }
// Decimal GB/TB. No subscription is a finite basic workspace, never unlimited.
export const FREE_WORKSPACE_LIMITS: Readonly<MembershipLimits> = Object.freeze({ seats: 1, concurrentGenerations: 1, storageBytes: 1_000_000_000 });
const resourceLimits: MembershipLimits[] = [
  { seats: 1, concurrentGenerations: 1, storageBytes: 10e9 },
  { seats: 3, concurrentGenerations: 2, storageBytes: 30e9 },
  { seats: 5, concurrentGenerations: 4, storageBytes: 100e9 },
  { seats: 10, concurrentGenerations: 8, storageBytes: 300e9 },
  { seats: 20, concurrentGenerations: 12, storageBytes: 500e9 },
  { seats: 50, concurrentGenerations: 20, storageBytes: 1e12 },
  { seats: 100, concurrentGenerations: 32, storageBytes: 2e12 },
];
export const MEMBERSHIP_PLANS = MEMBERSHIP_V1_PLANS.map((plan, index) => Object.freeze({
  ...plan, features: Object.keys(MEMBERSHIP_FEATURES) as MembershipFeature[], limits: Object.freeze(resourceLimits[index]),
}));
const MEMBERSHIP_CATALOGS: Record<string, (typeof MEMBERSHIP_V1_PLANS[number] & { limits?: Readonly<MembershipLimits> })[]> = Object.freeze({
  [MEMBERSHIP_V1_VERSION]: MEMBERSHIP_V1_PLANS,
  [MEMBERSHIP_VERSION]: MEMBERSHIP_PLANS,
});

export class MembershipError extends Error {
  constructor(message: string, public code = "MEMBERSHIP_INVALID", public status = 400) { super(message); this.name = "MembershipError"; }
  get statusCode() { return this.status; }
}

export interface MembershipSelection { planId: string; months: number; seedanceShare: number; version: string }
export interface MembershipQuote extends MembershipSelection {
  name: string; level: number; features: MembershipFeature[]; amountMicros: number;
  priceYuan: number; seedanceGu: number; h3Gu: number; seedanceMicros: number; h3Micros: number;
  giftValidityMonths: 12; quoteHash: string;
  limits?: Readonly<MembershipLimits>;
}

/** Integer quotation. Discounts buy additional restricted GU; consumption is never discounted twice. */
export function quoteMembership(selection: MembershipSelection): MembershipQuote {
  if (selection.version !== MEMBERSHIP_VERSION) throw new MembershipError("会员方案已更新，请重新选择", "MEMBERSHIP_QUOTE_INVALID");
  return quoteIssuedMembershipVersion(selection);
}

function quoteIssuedMembershipVersion(selection: MembershipSelection): MembershipQuote {
  const plan = MEMBERSHIP_CATALOGS[selection.version]?.find(item => item.id === selection.planId);
  if (!plan || ![1, 3, 12].includes(selection.months)
    || !Number.isInteger(selection.seedanceShare) || selection.seedanceShare < 10
    || selection.seedanceShare > 90 || selection.seedanceShare % 5 !== 0) {
    throw new MembershipError("会员方案已更新或参数无效，请重新选择", "MEMBERSHIP_QUOTE_INVALID");
  }
  const { months, seedanceShare } = selection;
  const payPercent = months === 1 ? 100 : plan.level < 2 ? (months === 3 ? 99 : 97) : (months === 3 ? 98 : 95);
  const denominator = seedanceShare * plan.seedancePayPercent + (100 - seedanceShare) * plan.h3PayPercent;
  const seedanceGu = Math.floor(plan.priceYuan * 1000 * seedanceShare / denominator);
  const h3Gu = Math.floor(plan.priceYuan * 1000 * (100 - seedanceShare) / denominator);
  const quote = { planId: plan.id, version: selection.version, months, seedanceShare, name: plan.name,
    level: plan.level, features: [...plan.features], amountMicros: plan.priceYuan * months * payPercent * (cnyMicrosPerYuan / 100),
    priceYuan: plan.priceYuan, seedanceGu, h3Gu, seedanceMicros: seedanceGu * guMicrosPerGu,
    h3Micros: h3Gu * guMicrosPerGu, giftValidityMonths: 12 as const,
    ...(plan.limits ? { limits: { ...plan.limits } } : {}) };
  return { ...quote, quoteHash: crypto.createHash("sha256").update(JSON.stringify(quote)).digest("hex") };
}

/** Validate a signed-internal order snapshot without repricing an already paid order. */
export function parseMembershipQuote(value: unknown): MembershipQuote {
  if (!value || typeof value !== "object") throw new MembershipError("会员订单快照缺失");
  const quote = value as MembershipQuote;
  const expected = quoteIssuedMembershipVersion(quote);
  if (Object.keys(expected).some(key => JSON.stringify(expected[key as keyof MembershipQuote]) !== JSON.stringify(quote[key as keyof MembershipQuote]))) {
    throw new MembershipError("会员订单快照校验失败", "MEMBERSHIP_SNAPSHOT_INVALID", 409);
  }
  return expected;
}

// Exact public model IDs only. Unknown models, aliases and additional services
// fall back to unrestricted funds instead of spending a restricted grant.
const seedanceModels = new Set(["seedance-2.0", "seedance-2.0-fast", "seedance-2.5", "seedance-2-0", "seedance-2-0-fast", "seedance-2-5",
  "doubao-seedance-2-0-260128", "doubao-seedance-2-0-fast-260128", "doubao-seedance-2-0-mini-260615", "doubao-seedance-2-5-260628"]);
const h3Models = new Set(["autodl-h3", "minimax-h3", "minimax-h3-standard"]);
export function membershipScopeForModel(model: unknown, endpointType: unknown): MembershipCreditScope | null {
  if (!["video", "video_generation", "videos"].includes(String(endpointType))) return null;
  const key = String(model || "").trim().toLowerCase();
  if (seedanceModels.has(key)) return "seedance";
  if (h3Models.has(key)) return "h3";
  return null;
}

export function membershipGrantApplies(metadata: Record<string, unknown>, input: {
  workspaceId?: string | null; metadata?: Record<string, unknown>;
}): boolean {
  if (!Object.hasOwn(metadata, "membership")) return true;
  const restriction = metadata.membership as { workspaceId?: string; tenantId?: string; scope?: string } | null;
  const context = input.metadata || {};
  const funding = context.membershipFunding as { tenantId?: string; scope?: string } | null;
  return !!restriction && !!funding && restriction.workspaceId === input.workspaceId
    && restriction.tenantId === funding.tenantId && restriction.scope === funding.scope
    && restriction.scope === membershipScopeForModel(context.model, context.endpointType);
}
