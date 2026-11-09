/** Ark only bills successful videos, including when a failed task has an ID.
 * https://docs.volcengine.com/docs/ark/model-pricing?lang=zh
 * A local failure/timeout is not a provider terminal response.
 */
export function isDefinitiveVideoTerminalRejection(input: {
  provider: unknown; providerTaskId: unknown; responseOk: boolean; response: any;
}): boolean {
  const p = input.response;
  if (input.provider !== "volcano" || !input.responseOk || !input.providerTaskId
    || !p || typeof p !== "object" || Array.isArray(p) || p.id !== input.providerTaskId
    || !["failed", "cancelled"].includes(p.status) || p.content?.video_url || p.video_url || p.output || p.result) return false;
  if (p.usage != null) {
    if (typeof p.usage !== "object" || Array.isArray(p.usage)
      || p.usage.completion_tokens !== 0 || (p.usage.total_tokens != null && p.usage.total_tokens !== 0)) return false;
    return true;
  }
  // Failed validation/moderation responses omit usage entirely. Unknown
  // terminal errors and cancellations need explicit zero-usage evidence.
  return p.status === "failed" && /^(?:InvalidParameter|MissingParameter)(?:[._:]|$)|^(?:Input|Output)(?:Text|Image|Video|Audio)?SensitiveContentDetected(?:[._:]|$)/.test(String(p.error?.code || ""));
}
