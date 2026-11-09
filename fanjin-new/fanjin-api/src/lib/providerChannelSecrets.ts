import {
  PROVIDER_CHANNEL_CREDENTIAL_CONFIG_KEY,
  PROVIDER_CHANNEL_FORBIDDEN_CREDENTIAL_INPUT_KEYS,
  PROVIDER_CHANNEL_RESERVED_CONFIG_KEYS,
  readProviderChannelCredentialCiphertext,
} from "@/lib/providerChannelCredentials";

export const REDACTED_PROVIDER_SECRET = "[REDACTED]";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, "");
}

export function isSensitiveProviderConfigKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (normalized.endsWith("ref") || normalized.endsWith("reference")) return false;
  return (
    normalized === "key" ||
    normalized === "ak" ||
    normalized === "sk" ||
    normalized === "apikey" ||
    normalized === "accesskey" ||
    normalized === "secretkey" ||
    normalized === "privatekey" ||
    normalized === "token" ||
    normalized === "secret" ||
    normalized === "password" ||
    normalized === "credential" ||
    normalized === "authorization" ||
    normalized === "accesstoken" ||
    normalized === "refreshtoken" ||
    normalized === "clientsecret" ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("accesskey") ||
    normalized.endsWith("secretkey") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("password") ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret")
  );
}

function hasSecretValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

function isRedactedPlaceholder(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return text === REDACTED_PROVIDER_SECRET || text.includes("[REDACTED]") || text.endsWith("_****");
}

export function containsInlineProviderSecret(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => containsInlineProviderSecret(item));
  if (!isPlainObject(value)) return false;
  return Object.entries(value).some(([key, child]) => {
    if (isSensitiveProviderConfigKey(key)) return hasSecretValue(child) && !isRedactedPlaceholder(child);
    return containsInlineProviderSecret(child);
  });
}

export function parseProviderChannelConfig(raw: unknown): Record<string, unknown> {
  if (isPlainObject(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function redactProviderChannelConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactProviderChannelConfig(item));
  if (!isPlainObject(value)) return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      (PROVIDER_CHANNEL_RESERVED_CONFIG_KEYS as readonly string[]).includes(key)
      || (PROVIDER_CHANNEL_FORBIDDEN_CREDENTIAL_INPUT_KEYS as readonly string[]).includes(key)
    ) continue;
    if (isSensitiveProviderConfigKey(key) && hasSecretValue(child)) {
      output[key] = REDACTED_PROVIDER_SECRET;
    } else {
      output[key] = redactProviderChannelConfig(child);
    }
  }
  return output;
}

export function mergeProviderChannelConfigForUpdate(
  existingRaw: unknown,
  incomingRaw: Record<string, unknown>,
): Record<string, unknown> {
  const existing = parseProviderChannelConfig(existingRaw);
  const storedCredential = readProviderChannelCredentialCiphertext(existing);
  const reservedEntries = Object.fromEntries(
    PROVIDER_CHANNEL_RESERVED_CONFIG_KEYS
      .filter((key) => Object.prototype.hasOwnProperty.call(existing, key))
      .map((key) => [key, existing[key]]),
  );

  const mergeValue = (current: unknown, incoming: unknown, key = ""): unknown => {
    if (isSensitiveProviderConfigKey(key) && isRedactedPlaceholder(incoming)) return current;
    if (isPlainObject(current) && isPlainObject(incoming)) {
      const output: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(incoming)) {
        output[childKey] = mergeValue(current[childKey], childValue, childKey);
      }
      return output;
    }
    return incoming;
  };

  const merged = mergeValue(existing, incomingRaw) as Record<string, unknown>;
  for (const key of PROVIDER_CHANNEL_RESERVED_CONFIG_KEYS) delete merged[key];
  for (const key of PROVIDER_CHANNEL_FORBIDDEN_CREDENTIAL_INPUT_KEYS) delete merged[key];
  if (storedCredential) reservedEntries[PROVIDER_CHANNEL_CREDENTIAL_CONFIG_KEY] = storedCredential;
  return { ...merged, ...reservedEntries };
}
