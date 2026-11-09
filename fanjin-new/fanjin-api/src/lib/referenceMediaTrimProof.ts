import { createHash, timingSafeEqual } from "node:crypto";
import { secretPurposeHmac } from "./secretEnvelope";
import type { VideoGenerationInput } from "./videoGenerationContract";

function binding(input: VideoGenerationInput, content: Record<string, unknown>): string {
  const url = (content[`${input.mediaType}_url`] as { url?: unknown } | undefined)?.url;
  return JSON.stringify([
    "reference-media-trim/v1", input.assetVersionId, input.mediaType, input.role, input.order,
    input.trim?.startMs, input.trim?.endMs,
    createHash("sha256").update(typeof url === "string" ? url : "").digest("hex"),
  ]);
}

/** Server-only receipt: the selected range has been encoded into this exact URL. */
export function bindPreparedReferenceTrim(input: VideoGenerationInput, content: Record<string, unknown>): void {
  content.reference_trim_receipt = secretPurposeHmac(binding(input, content), "reference-media-trim");
}

export function hasPreparedReferenceTrim(input: VideoGenerationInput, content?: Record<string, unknown>): boolean {
  if (!input.trim) return true;
  if (!content || !["audio", "video"].includes(input.mediaType)) return false;
  const actual = content.reference_trim_receipt;
  if (typeof actual !== "string" || !/^hmac-sha256:[a-f0-9]{64}$/u.test(actual)) return false;
  const expected = secretPurposeHmac(binding(input, content), "reference-media-trim");
  return actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
