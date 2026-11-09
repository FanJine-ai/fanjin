const MAX_PORTRAIT_CONTROL_RESPONSE_BYTES = 64 * 1024;

/**
 * Read a detector/moderation control response with a hard byte ceiling.
 * Checking only after `response.text()` would let a compromised upstream use
 * an unbounded body to exhaust the Worker before the validation runs.
 */
export async function readPortraitControlResponse(
  response: Response,
  maximumBytes = MAX_PORTRAIT_CONTROL_RESPONSE_BYTES,
): Promise<string> {
  const declaredText = response.headers.get("content-length");
  if (declaredText) {
    const declared = Number(declaredText);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maximumBytes) {
      throw new Error("portrait control response is too large");
    }
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maximumBytes) {
      throw new Error("portrait control response is too large");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("portrait control response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}
