type BrowserCrypto = Pick<Crypto, "randomUUID" | "getRandomValues">;

let fallbackSequence = 0;

function formatUuid(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

function createNonCryptographicUuid(): string {
  fallbackSequence = (fallbackSequence + 1) >>> 0;
  const bytes = new Uint8Array(16);
  const timestamp = Date.now();
  const highResolutionTime = typeof performance !== "undefined"
    ? Math.floor(performance.now() * 1_000)
    : 0;

  for (let index = 0; index < bytes.length; index += 1) {
    const timeByte = Math.floor(timestamp / (2 ** ((index % 6) * 8))) & 0xff;
    const sequenceByte = (fallbackSequence >>> ((index % 4) * 8)) & 0xff;
    const performanceByte = (highResolutionTime >>> ((index % 4) * 8)) & 0xff;
    bytes[index] = Math.floor(Math.random() * 256) ^ timeByte ^ sequenceByte ^ performanceByte;
  }

  return formatUuid(bytes);
}

/**
 * Creates a client-side request identifier in secure and non-secure browser contexts.
 * The final fallback is intentionally non-cryptographic and must not be used as a secret.
 */
export function createBrowserUuid(
  cryptoSource: Partial<BrowserCrypto> | null | undefined = globalThis.crypto,
): string {
  if (typeof cryptoSource?.randomUUID === "function") {
    try {
      return cryptoSource.randomUUID.call(cryptoSource);
    } catch {
      // Continue to getRandomValues for partial or non-standard Crypto implementations.
    }
  }

  if (typeof cryptoSource?.getRandomValues === "function") {
    try {
      const bytes = new Uint8Array(16);
      cryptoSource.getRandomValues.call(cryptoSource, bytes);
      return formatUuid(bytes);
    } catch {
      // Continue to the low-collision, non-cryptographic request-id fallback.
    }
  }

  return createNonCryptographicUuid();
}
