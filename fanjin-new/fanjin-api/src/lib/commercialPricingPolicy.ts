import { guMicrosPerGu, guPerYuan, cnyMicrosPerYuan } from "./billingUnits";

export const COMMERCIAL_PRICE_VERSION = "fanjin-commercial-20260909/v1";
export const PROCUREMENT_DISCOUNT_BPS = 8500;
export const OPERATING_RESERVE_BPS = 300;
export const MINIMUM_CONTRIBUTION_BPS = 700;
export interface CreditPackage {
  id: string; kind: "credits" | "membership"; name: string;
  priceYuan: number; creditsGu: number; giftGu: number;
}
// The superseded three-tier proposal must not become purchasable when WeChat is
// enabled. The seven-tier Seedance/H3 allocation UI is still a preview; publish
// its model-specific entitlement implementation before adding a sale catalogue.
// Existing orders continue to settle/refund using their immutable snapshots.
export const CREDIT_PACKAGES: readonly CreditPackage[] = Object.freeze([]);

/** Full redemption at official list retail, including all package credits. No breakage assumed. */
export function creditPackageEconomics(pack: { priceYuan: number; creditsGu: number }) {
  const receiptsCnyMicros = Math.round(pack.priceYuan * cnyMicrosPerYuan);
  const maximumSupplierCnyMicros = Math.ceil(pack.creditsGu / guPerYuan * cnyMicrosPerYuan * PROCUREMENT_DISCOUNT_BPS / 10_000);
  const operatingReserveCnyMicros = Math.ceil(receiptsCnyMicros * OPERATING_RESERVE_BPS / 10_000);
  const contributionCnyMicros = receiptsCnyMicros - maximumSupplierCnyMicros - operatingReserveCnyMicros;
  return { receiptsCnyMicros, maximumSupplierCnyMicros, operatingReserveCnyMicros, contributionCnyMicros,
    passes: contributionCnyMicros * 10_000 >= receiptsCnyMicros * MINIMUM_CONTRIBUTION_BPS };
}

export function resolveCreditPackage(id: string) {
  const pack = CREDIT_PACKAGES.find((entry) => entry.id === id);
  if (!pack || !creditPackageEconomics(pack).passes) throw new Error("创作套餐不存在或未通过成本校验");
  return { ...pack, version: COMMERCIAL_PRICE_VERSION, amountMicros: pack.priceYuan * cnyMicrosPerYuan,
    creditedGuMicros: (pack.creditsGu - pack.giftGu) * guMicrosPerGu,
    giftGuMicros: pack.giftGu * guMicrosPerGu,
    membershipMonths: pack.kind === "membership" ? 1 : 0,
    giftValidityMonths: pack.kind === "membership" ? 12 : null,
    expiresAt: null, recurring: false };
}

/** Clamp month ends so a Jan 31 purchase expires at February's last day. */
export function addMembershipMonths(at: number, months: number): number {
  const date = new Date(at);
  const day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.getTime();
}
