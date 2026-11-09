/** Count references from the trusted request; image token usage is not an image count. */
export function imageReferenceCount(request: unknown): number {
  const image = (request as any)?.image;
  return Array.isArray(image) ? image.length : typeof image === "string" && image ? 1 : 0;
}

export function additionalImageReferenceCost(ruleConfig: Record<string, unknown>, count?: number): number {
  const config = ruleConfig.referenceImagePricing as Record<string, unknown> | undefined;
  if (!config) return 0;
  const included = Number(config.firstIncluded);
  const price = Number(config.additionalUnitPriceMicros);
  const maximum = Number(config.maximumReferenceImages ?? 14);
  const references = count ?? maximum; // A quote without reference details is a ceiling.
  if (![included, price, maximum, references].every(Number.isSafeInteger) || included < 0 || price < 0 || maximum < included || references < 0 || references > maximum) throw new Error("图片参考图计费参数无效");
  const cost = Math.max(0, references - included) * price;
  if (!Number.isSafeInteger(cost)) throw new Error("图片参考图计费金额超出安全范围");
  return cost;
}
