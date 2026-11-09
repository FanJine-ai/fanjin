/** Native adaptive 480p is a pixel-area tier, not a 480px short-edge promise.
 * Keep enhancement checks strict; require the exact provider's terminal receipt.
 */
export function isSeedanceAdaptive480pDelivery(input: {
  provider: unknown; model: unknown; providerTaskId: unknown; requestRatio: unknown;
  responseId: unknown; responseStatus: unknown; responseResolution: unknown; responseRatio: unknown;
  width: number; height: number;
}): boolean {
  if (input.provider !== "volcano" || !["doubao-seedance-2-5-260628", "dreamina-seedance-2-5-260628"].includes(String(input.model))
    || input.requestRatio !== "adaptive" || !input.providerTaskId || input.responseId !== input.providerTaskId
    || input.responseStatus !== "succeeded" || input.responseResolution !== "480p"
    || !Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height)
    || input.width <= 0 || input.height <= 0 || input.width * input.height < 854 * 480) return false;
  const match = String(input.responseRatio || "").match(/^(\d+):(\d+)$/);
  if (!match || !Number(match[1]) || !Number(match[2])) return false;
  const ratio = Number(match[1]) / Number(match[2]);
  return ratio >= 1 / 3 && ratio <= 3 && Math.abs(input.width / input.height / ratio - 1) <= 0.005;
}
