export interface JwsImageQuote { model?: string; amount: number; currency: "USD"; quoteId: string; pricingMode: "fixed" | "usage"; }
export interface JwsImageCharge { amount: number; currency: "USD"; taskId: string; billingStatus: "charged"; settlementStatus?: string; }
interface JwsImageConversion { cnyPerUpstreamUsd: number; guPerCny: 10; conversionBasis: "official_fx" | "account_purchase"; conversionDate: string; }
export type JwsImagePricePolicy = JwsImageConversion & ({version:"jws-upstream-pass-through.v1"} | {version:"jws-upstream-cost-plus.v1";markupBps:number});

export function jwsImagePricePolicy(config: Record<string,unknown>): JwsImagePricePolicy | null {
  if(config.jwsUpstreamPricing === undefined)return null;
  const value=config.jwsUpstreamPricing as JwsImagePricePolicy;
  if(!value || !["jws-upstream-pass-through.v1","jws-upstream-cost-plus.v1"].includes(value.version) || !Number.isFinite(value.cnyPerUpstreamUsd) || value.cnyPerUpstreamUsd<=0 || value.cnyPerUpstreamUsd>100 || value.guPerCny!==10 || !["official_fx","account_purchase"].includes(value.conversionBasis) || !/^\d{4}-\d{2}-\d{2}$/.test(value.conversionDate))throw Error("JWS_IMAGE_PRICE_POLICY_INVALID");
  if(value.version==="jws-upstream-cost-plus.v1" && (!Number.isSafeInteger(value.markupBps) || value.markupBps<0 || value.markupBps>100_000))throw Error("JWS_IMAGE_PRICE_MARKUP_INVALID");
  if(value.version==="jws-upstream-pass-through.v1" && "markupBps" in value)throw Error("JWS_IMAGE_PRICE_POLICY_INVALID");
  return {...value};
}

/** Amount is an entire order, already multiplied by its image count. */
export function jwsImageAmountMicros(amount: number, currency: string, policy: JwsImagePricePolicy): number {
  if(currency!=="USD" || !Number.isFinite(amount) || amount<0)throw Error("JWS_IMAGE_AMOUNT_INVALID");
  const result=Math.round(amount*policy.cnyPerUpstreamUsd*policy.guPerCny*100_000_000);
  if(!Number.isSafeInteger(result) || result<0)throw Error("JWS_IMAGE_AMOUNT_OVERFLOW");
  return result;
}

/** Retail is cost plus the snapshotted markup; it is not a new FX rate. */
export function jwsImageRetailAmountMicros(amount:number,currency:string,policy:JwsImagePricePolicy):number {
  jwsImageAmountMicros(amount,currency,policy);
  const multiplier=policy.version==="jws-upstream-cost-plus.v1"?1+policy.markupBps/10_000:1;
  const result=Math.round(amount*policy.cnyPerUpstreamUsd*policy.guPerCny*100_000_000*multiplier);
  if(!Number.isSafeInteger(result) || result<0)throw Error("JWS_IMAGE_AMOUNT_OVERFLOW");
  return result;
}
