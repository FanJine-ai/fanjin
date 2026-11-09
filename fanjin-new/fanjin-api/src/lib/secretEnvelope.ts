import crypto from "node:crypto";

const PREFIX = "sealed:v1";
const ALGORITHM = "aes-256-gcm";

function decodeMasterKey(raw: string): Buffer {
  const value = raw.trim();
  if (value.startsWith("base64:")) {
    const material = Buffer.from(value.slice(7), "base64");
    if (material.length !== 32) throw new Error("base64 settings encryption key must decode to 32 bytes");
    return material;
  }
  if (value.startsWith("hex:")) {
    const material = Buffer.from(value.slice(4), "hex");
    if (material.length !== 32) throw new Error("hex settings encryption key must decode to 32 bytes");
    return material;
  }
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new Error("settings encryption key must contain at least 32 bytes of secret material");
  }
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

function configuredKey(): Buffer {
  const raw = String(process.env.FANJIN_SETTINGS_ENCRYPTION_KEY || "").trim();
  if (raw) return decodeMasterKey(raw);
  if (process.env.NODE_ENV === "prod") {
    throw new Error("FANJIN_SETTINGS_ENCRYPTION_KEY is required in production");
  }
  const developmentSeed = String(process.env.FANJIN_ROOT_PASSWORD || "fanjin-development-settings-key-only");
  return crypto.createHash("sha256").update(developmentSeed, "utf8").digest();
}

function purposeKey(master: Buffer, purpose: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", master, Buffer.from("fanjin-settings-v1"), Buffer.from(purpose), 32));
}

function aad(purpose: string): Buffer {
  return Buffer.from(`${PREFIX}:${purpose}`, "utf8");
}

export function isSealedSecret(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(`${PREFIX}:`);
}

export function hasSettingsEncryptionKey(): boolean {
  try {
    configuredKey();
    return true;
  } catch {
    return false;
  }
}

export function sealSecret(plaintext: string, purpose: string): string {
  if (!purpose.trim()) throw new Error("secret purpose is required");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, purposeKey(configuredKey(), purpose), iv);
  cipher.setAAD(aad(purpose));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

export function openSecret(envelope: string, purpose: string): string {
  const parts = envelope.split(":");
  if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== PREFIX) throw new Error("secret envelope format is invalid");
  const [, , ivValue, tagValue, ciphertextValue] = parts;
  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      purposeKey(configuredKey(), purpose),
      Buffer.from(ivValue, "base64url"),
    );
    decipher.setAAD(aad(purpose));
    decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("secret envelope authentication failed");
  }
}

/**
 * Derives a stable, non-reversible binding from protected configuration.
 * The purpose is domain-separated from every AEAD purpose so a binding can
 * never be reused as an encryption key or as a provider credential.
 */
export function secretPurposeHmac(value: string, purpose: string): string {
  if (!purpose.trim()) throw new Error("secret HMAC purpose is required");
  const master = configuredKey();
  const key = purposeKey(master, `hmac:${purpose}`);
  try {
    return `hmac-sha256:${crypto.createHmac("sha256", key).update(value, "utf8").digest("hex")}`;
  } finally {
    master.fill(0);
    key.fill(0);
  }
}
