import type { PricingModel } from "../types";

export function pricingModelCapabilities(model: PricingModel): string[] {
  const values = [
    model.default_resolution,
    ...(model.resolutions || []),
    model.default_quality,
    ...(model.qualities || []),
    ...(model.capabilities || []),
    model.output,
  ];
  return values.reduce<string[]>((result, value) => {
    const normalized = String(value || "").trim();
    if (normalized && !result.includes(normalized)) result.push(normalized);
    return result;
  }, []);
}
