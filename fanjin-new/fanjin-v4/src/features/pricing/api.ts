import type { PricingData } from "./types";
import { apiGet, readApiSettings, type ApiRequestOptions } from "../../api/http";

export async function getPricing(options?: ApiRequestOptions): Promise<PricingData> {
  return apiGet<PricingData>("/public/pricing", readApiSettings(), options);
}
