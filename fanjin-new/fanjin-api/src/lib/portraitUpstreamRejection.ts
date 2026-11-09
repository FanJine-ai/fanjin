import { isDefinitiveVideoRejection } from "@/lib/definitiveVideoRejection";

export const UPSTREAM_REAL_PERSON_REJECTION = "PORTRAIT_UPSTREAM_REAL_PERSON_REJECTED";

export function hasUpstreamRealPersonRejection(row: Record<string, any>): boolean {
  return row.safeErrorCode === UPSTREAM_REAL_PERSON_REJECTION;
}

export function canDeclareUpstreamRejectedPortrait(row: Record<string, any>): boolean {
  return hasUpstreamRealPersonRejection(row)
    && !["denied", "revoked", "expired"].includes(String(row.complianceState))
    && ["ordinary", "pending"].includes(String(row.subjectKind));
}

export function isDeclaredPortrait(row: Record<string, any>): boolean {
  return row.declarationState === "confirmed"
    && ["real_person", "virtual_person", "trusted_output"].includes(String(row.subjectKind));
}

function object(value: unknown): Record<string, any> {
  if (typeof value === "string") {
    try { return object(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

/** Attribute an explicit provider refusal to the exact persisted input. Text
 * occupies content slots too; content[1] must not be interpreted as image #2.
 * Ambiguous/missing mappings never label every reference as rejected. */
export function resolveUpstreamRealPersonRejection(task: {
  provider?: unknown; providerTaskId?: unknown; providerPayload?: unknown; resultPayload?: unknown;
}): { assetVersionId: number; referenceNumber: number; contentIndex: number } | null {
  const provider = object(task.providerPayload);
  const response = object(provider.response);
  if (!isDefinitiveVideoRejection({ provider: task.provider, providerTaskId: task.providerTaskId,
    httpStatus: object(provider.submission).httpStatus, response })) return null;
  const error = object(response.error);
  if (!/may contain real person|可能.*真人/i.test(String(error.message || ""))) return null;
  const parameter = String(error.param || "").match(/^content\[(\d+)\]$/);
  const matches = [...String(error.message || "").matchAll(/content\[(\d+)\]/g)];
  if (matches.length > 1) return null;
  const index = Number(parameter?.[1] ?? matches[0]?.[1] ?? NaN);
  if (!Number.isSafeInteger(index) || index < 0 || (parameter && matches[0] && parameter[1] !== matches[0][1])) return null;
  const content = object(provider.request).content;
  const request = object(object(object(task.resultPayload).internal).canonicalVideoGeneration).request;
  const inputs = object(request).inputs;
  if (!Array.isArray(content) || !Array.isArray(inputs) || !["image_url", "video_url"].includes(content[index]?.type)) return null;
  const media = content.map((item, contentIndex) => ({ type: object(item).type, contentIndex })).filter(item => item.type !== "text");
  const ordered = inputs.map(object).sort((a, b) => a.order - b.order);
  if (media.length !== ordered.length || ordered.some((input, order) => input.order !== order
    || media[order].type !== `${input.mediaType}_url`)) return null;
  const order = media.findIndex(item => item.contentIndex === index);
  const assetVersionId = Number(ordered[order]?.assetVersionId);
  return Number.isSafeInteger(assetVersionId) && assetVersionId > 0
    ? { assetVersionId, referenceNumber: order + 1, contentIndex: index } : null;
}
