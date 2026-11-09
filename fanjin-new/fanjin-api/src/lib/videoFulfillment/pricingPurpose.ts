export const VALUE_VIDEO_FULFILLMENT_PRICE_PURPOSE = "value_video_fulfillment";

/** Internal fulfillment costs must not enable or overwrite the standalone enhancement product. */
export function isValueVideoFulfillmentPrice(row: { ruleConfig?: unknown }): boolean {
  let config = row.ruleConfig;
  if (typeof config === "string") {
    try { config = JSON.parse(config); } catch { return false; }
  }
  return Boolean(config && typeof config === "object"
    && (config as Record<string, unknown>).billingPurpose === VALUE_VIDEO_FULFILLMENT_PRICE_PURPOSE);
}
