import crypto from "node:crypto";

import {
  isSealedSecret,
  openSecret,
  sealSecret,
  secretPurposeHmac,
} from "@/lib/secretEnvelope";

const PURPOSE_PREFIX = "provider-channel-credential";
const PORTRAIT_PURPOSE_PREFIX = "provider-channel-portrait-credential";
const IMAGEX_REVIEW_PURPOSE_PREFIX = "provider-channel-imagex-review-credential";
const PORTRAIT_BINDING_PURPOSE = "provider-channel-portrait-binding/v1";
const IMAGEX_REVIEW_BINDING_PURPOSE = "provider-channel-imagex-review-binding/v1";
const MAX_PORTRAIT_CREDENTIAL_BYTES = 1_024;
const MAX_IMAGEX_REVIEW_CREDENTIAL_BYTES = 1_536;
const PORTRAIT_BINDING_PATTERN = /^hmac-sha256:[a-f0-9]{64}$/u;
const IMAGEX_REVIEW_BINDING_PATTERN = /^hmac-sha256:[a-f0-9]{64}$/u;
export const PROVIDER_CHANNEL_CREDENTIAL_CONFIG_KEY = "__fanjinCredentialCiphertext";
export const PROVIDER_CHANNEL_PORTRAIT_CREDENTIAL_CONFIG_KEY = "__fanjinPortraitCredentialCiphertext";
export const PROVIDER_CHANNEL_PORTRAIT_CREDENTIAL_GENERATION_CONFIG_KEY = "__fanjinPortraitCredentialGeneration";
export const PROVIDER_CHANNEL_PORTRAIT_CREDENTIAL_BINDING_CONFIG_KEY = "__fanjinPortraitCredentialBinding";
export const PROVIDER_CHANNEL_PORTRAIT_ASSETS_ENABLED_CONFIG_KEY = "portraitAssetsEnabled";
export const PROVIDER_CHANNEL_PORTRAIT_ACCOUNT_ID_CONFIG_KEY = "providerAccountId";
export const PROVIDER_CHANNEL_PORTRAIT_PROJECT_NAME_CONFIG_KEY = "assetsProjectName";
/**
 * Explicit operator attestation that this image-generation adapter accepts
 * Volcano private portrait `asset://` references. Merely being a Volcano
 * channel is not sufficient proof of that wire protocol.
 */
export const PROVIDER_CHANNEL_IMAGE_PORTRAIT_ASSET_URI_ENABLED_CONFIG_KEY =
  "portraitAssetUriImageGenerationEnabled";
export const PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_CONFIG_KEY = "__fanjinImageXReviewCredentialCiphertext";
export const PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_GENERATION_CONFIG_KEY = "__fanjinImageXReviewCredentialGeneration";
export const PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_BINDING_CONFIG_KEY = "__fanjinImageXReviewCredentialBinding";
export const PROVIDER_CHANNEL_IMAGEX_REVIEW_ENABLED_CONFIG_KEY = "imagexPortraitReviewEnabled";
export const TOKENHEX_PORTRAIT_CREDENTIAL_VERSION = "fanjin-tokenhex-portrait-credential/v1";
export const TOKENHEX_PORTRAIT_ORIGIN = "https://api.tokenhex.com";
export const PROVIDER_CHANNEL_PORTRAIT_CREDENTIAL_VERSION = "fanjin-volcano-portrait-credential/v1";
export const PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_VERSION = "fanjin-volcano-imagex-review-credential/v1";

export const PROVIDER_CHANNEL_RESERVED_CONFIG_KEYS = Object.freeze([
  PROVIDER_CHANNEL_CREDENTIAL_CONFIG_KEY,
  PROVIDER_CHANNEL_PORTRAIT_CREDENTIAL_CONFIG_KEY,
  PROVIDER_CHANNEL_PORTRAIT_CREDENTIAL_GENERATION_CONFIG_KEY,
  PROVIDER_CHANNEL_PORTRAIT_CREDENTIAL_BINDING_CONFIG_KEY,
  PROVIDER_CHANNEL_PORTRAIT_ASSETS_ENABLED_CONFIG_KEY,
  PROVIDER_CHANNEL_PORTRAIT_ACCOUNT_ID_CONFIG_KEY,
  PROVIDER_CHANNEL_PORTRAIT_PROJECT_NAME_CONFIG_KEY,
  PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_CONFIG_KEY,
  PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_GENERATION_CONFIG_KEY,
  PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_BINDING_CONFIG_KEY,
  PROVIDER_CHANNEL_IMAGEX_REVIEW_ENABLED_CONFIG_KEY,
] as const);

export const PROVIDER_CHANNEL_FORBIDDEN_CREDENTIAL_INPUT_KEYS = Object.freeze([
  "portraitAccessKeyId",
  "portraitSecretAccessKey",
  "portraitSessionToken",
  "imagexServiceId",
  "imagexAccessKeyId",
  "imagexSecretAccessKey",
  "imagexSessionToken",
  // Deprecated and deliberately ignored. ImageGenerations documents only
  // URL/Base64 references; an Admin boolean cannot attest an `asset://` wire
  // protocol that the provider does not publish for image generation.
  PROVIDER_CHANNEL_IMAGE_PORTRAIT_ASSET_URI_ENABLED_CONFIG_KEY,
] as const);

export type ProviderChannelPortraitCredential = Readonly<{
  version: typeof PROVIDER_CHANNEL_PORTRAIT_CREDENTIAL_VERSION;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}>;

export type TokenhexPortraitCredential = Readonly<{
  version: typeof TOKENHEX_PORTRAIT_CREDENTIAL_VERSION;
  bearerToken: string;
}>;
export type AnyProviderChannelPortraitCredential = ProviderChannelPortraitCredential | TokenhexPortraitCredential;
export type ProviderChannelPortraitCredentialInput =
  | (Omit<ProviderChannelPortraitCredential, "version"> & { version?: string })
  | TokenhexPortraitCredential;

export type ProviderChannelPortraitCredentialMetadata = Readonly<{
  enabled: boolean;
  ciphertextPresent: boolean;
  generation: number;
  binding: string;
}>;

export type ProviderChannelPortraitCredentialInspection = Readonly<
  ProviderChannelPortraitCredentialMetadata & {
    configured: boolean;
    serializedCredential: string;
    credential: AnyProviderChannelPortraitCredential | null;
  }
>;

export type ProviderChannelImageXReviewCredential = Readonly<{
  version: typeof PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_VERSION;
  serviceId: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}>;

export type ProviderChannelImageXReviewCredentialMetadata = Readonly<{
  enabled: boolean;
  ciphertextPresent: boolean;
  generation: number;
  binding: string;
}>;

export type ProviderChannelImageXReviewCredentialInspection = Readonly<
  ProviderChannelImageXReviewCredentialMetadata & {
    configured: boolean;
    serializedCredential: string;
    credential: ProviderChannelImageXReviewCredential | null;
  }
>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseConfig(value: unknown): Record<string, unknown> {
  if (isPlainObject(value)) return { ...value };
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function purpose(channelId: string): string {
  const id = cleanString(channelId);
  if (!id) throw new Error("provider channel id is required for credential encryption");
  return `${PURPOSE_PREFIX}:${id}`;
}

function portraitPurpose(channelId: string): string {
  const id = cleanString(channelId);
  if (!id) throw new Error("provider channel id is required for portrait credential encryption");
  return `${PORTRAIT_PURPOSE_PREFIX}:${id}`;
}

function imageXReviewPurpose(channelId: string): string {
  const id = cleanString(channelId);
  if (!id) throw new Error("provider channel id is required for ImageX review credential encryption");
  return `${IMAGEX_REVIEW_PURPOSE_PREFIX}:${id}`;
}

function exactPortraitCredentialRecord(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  const allowed = new Set(["version", "accessKeyId", "secretAccessKey", "sessionToken"]);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.has(key))
    || !Object.prototype.hasOwnProperty.call(value, "version")
    || !Object.prototype.hasOwnProperty.call(value, "accessKeyId")
    || !Object.prototype.hasOwnProperty.call(value, "secretAccessKey")
  ) return null;
  return value;
}

function exactImageXReviewCredentialRecord(value: unknown): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  const allowed = new Set(["version", "serviceId", "accessKeyId", "secretAccessKey", "sessionToken"]);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.has(key))
    || !Object.prototype.hasOwnProperty.call(value, "version")
    || !Object.prototype.hasOwnProperty.call(value, "serviceId")
    || !Object.prototype.hasOwnProperty.call(value, "accessKeyId")
    || !Object.prototype.hasOwnProperty.call(value, "secretAccessKey")
  ) return null;
  return value;
}

function exactOpaqueSecret(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value || value !== value.trim()) return "";
  if (value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) return "";
  return value;
}

function safeGeneration(value: unknown): number {
  const generation = Number(value);
  return Number.isSafeInteger(generation) && generation > 0 ? generation : 0;
}

function sameBinding(left: string, right: string): boolean {
  if (!PORTRAIT_BINDING_PATTERN.test(left) || !PORTRAIT_BINDING_PATTERN.test(right)) return false;
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sameImageXReviewBinding(left: string, right: string): boolean {
  if (!IMAGEX_REVIEW_BINDING_PATTERN.test(left) || !IMAGEX_REVIEW_BINDING_PATTERN.test(right)) return false;
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function encodeProviderChannelPortraitCredential(
  input: ProviderChannelPortraitCredentialInput,
): string {
  if ("bearerToken" in input) {
    if (input.version !== TOKENHEX_PORTRAIT_CREDENTIAL_VERSION
      || Reflect.ownKeys(input).some((key) => key !== "version" && key !== "bearerToken")) {
      throw new Error("Tokenhex portrait credential envelope is invalid");
    }
    const bearerToken = exactOpaqueSecret(input.bearerToken, 768);
    if (!bearerToken || /\s/u.test(bearerToken)) throw new Error("Tokenhex portrait credential is invalid");
    return JSON.stringify({ version: TOKENHEX_PORTRAIT_CREDENTIAL_VERSION, bearerToken });
  }
  const accessKeyId = cleanString(input.accessKeyId);
  const secretAccessKey = exactOpaqueSecret(input.secretAccessKey, 512);
  const sessionToken = input.sessionToken === undefined
    ? ""
    : exactOpaqueSecret(input.sessionToken, 768);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/u.test(accessKeyId)) {
    throw new Error("portrait credential access key id is invalid");
  }
  if (!secretAccessKey) throw new Error("portrait credential secret access key is invalid");
  if (input.sessionToken !== undefined && !sessionToken) {
    throw new Error("portrait credential session token is invalid");
  }
  if (input.version !== undefined && input.version !== PROVIDER_CHANNEL_PORTRAIT_CREDENTIAL_VERSION) {
    throw new Error("portrait credential version is invalid");
  }
  const serialized = JSON.stringify({
    version: PROVIDER_CHANNEL_PORTRAIT_CREDENTIAL_VERSION,
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  });
  if (Buffer.byteLength(serialized, "utf8") > MAX_PORTRAIT_CREDENTIAL_BYTES) {
    throw new Error("portrait credential envelope is too large");
  }
  return serialized;
}

export function parseProviderChannelPortraitCredential(
  serialized: unknown,
): AnyProviderChannelPortraitCredential | null {
  if (typeof serialized !== "string" || !serialized || Buffer.byteLength(serialized, "utf8") > MAX_PORTRAIT_CREDENTIAL_BYTES) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (isPlainObject(parsed) && parsed.version === TOKENHEX_PORTRAIT_CREDENTIAL_VERSION) {
    try {
      return Object.freeze(JSON.parse(encodeProviderChannelPortraitCredential(parsed as TokenhexPortraitCredential)) as TokenhexPortraitCredential);
    } catch { return null; }
  }
  const record = exactPortraitCredentialRecord(parsed);
  if (!record || record.version !== PROVIDER_CHANNEL_PORTRAIT_CREDENTIAL_VERSION) return null;
  try {
    const canonical = encodeProviderChannelPortraitCredential({
      version: String(record.version),
      accessKeyId: record.accessKeyId as string,
      secretAccessKey: record.secretAccessKey as string,
      ...(record.sessionToken === undefined ? {} : { sessionToken: record.sessionToken as string }),
    });
    const canonicalRecord = JSON.parse(canonical) as ProviderChannelPortraitCredential;
    return Object.freeze(canonicalRecord);
  } catch {
    return null;
  }
}

export function encodeProviderChannelImageXReviewCredential(
  input: Omit<ProviderChannelImageXReviewCredential, "version"> & { version?: string },
): string {
  const serviceId = cleanString(input.serviceId);
  const accessKeyId = cleanString(input.accessKeyId);
  const secretAccessKey = exactOpaqueSecret(input.secretAccessKey, 512);
  const sessionToken = input.sessionToken === undefined
    ? ""
    : exactOpaqueSecret(input.sessionToken, 768);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(serviceId)) {
    throw new Error("ImageX review credential service id is invalid");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/u.test(accessKeyId)) {
    throw new Error("ImageX review credential access key id is invalid");
  }
  if (!secretAccessKey) throw new Error("ImageX review credential secret access key is invalid");
  if (input.sessionToken !== undefined && !sessionToken) {
    throw new Error("ImageX review credential session token is invalid");
  }
  if (input.version !== undefined && input.version !== PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_VERSION) {
    throw new Error("ImageX review credential version is invalid");
  }
  const serialized = JSON.stringify({
    version: PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_VERSION,
    serviceId,
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  });
  if (Buffer.byteLength(serialized, "utf8") > MAX_IMAGEX_REVIEW_CREDENTIAL_BYTES) {
    throw new Error("ImageX review credential envelope is too large");
  }
  return serialized;
}

export function parseProviderChannelImageXReviewCredential(
  serialized: unknown,
): ProviderChannelImageXReviewCredential | null {
  if (
    typeof serialized !== "string"
    || !serialized
    || Buffer.byteLength(serialized, "utf8") > MAX_IMAGEX_REVIEW_CREDENTIAL_BYTES
  ) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  const record = exactImageXReviewCredentialRecord(parsed);
  if (!record || record.version !== PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_VERSION) return null;
  try {
    const canonical = encodeProviderChannelImageXReviewCredential({
      version: String(record.version),
      serviceId: record.serviceId as string,
      accessKeyId: record.accessKeyId as string,
      secretAccessKey: record.secretAccessKey as string,
      ...(record.sessionToken === undefined ? {} : { sessionToken: record.sessionToken as string }),
    });
    return Object.freeze(JSON.parse(canonical) as ProviderChannelImageXReviewCredential);
  } catch {
    return null;
  }
}

function portraitCredentialBinding(input: {
  channelId: string;
  generation: number;
  accessKeyId: string;
}): string {
  return secretPurposeHmac(JSON.stringify({
    accessKeyId: input.accessKeyId,
    channelId: input.channelId,
    generation: input.generation,
    version: PROVIDER_CHANNEL_PORTRAIT_CREDENTIAL_VERSION,
  }), PORTRAIT_BINDING_PURPOSE);
}

function imageXReviewCredentialBinding(input: {
  channelId: string;
  generation: number;
  serviceId: string;
  accessKeyId: string;
}): string {
  return secretPurposeHmac(JSON.stringify({
    accessKeyId: input.accessKeyId,
    channelId: input.channelId,
    generation: input.generation,
    serviceId: input.serviceId,
    version: PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_VERSION,
  }), IMAGEX_REVIEW_BINDING_PURPOSE);
}

export function sealProviderChannelCredential(channelId: string, plaintext: string): string {
  const secret = cleanString(plaintext);
  if (!secret) throw new Error("provider channel credential is required");
  return sealSecret(secret, purpose(channelId));
}

export function openProviderChannelCredential(channelId: string, ciphertext: unknown): string {
  const envelope = cleanString(ciphertext);
  if (!envelope || !isSealedSecret(envelope)) return "";
  try {
    return openSecret(envelope, purpose(channelId));
  } catch {
    // Fail closed when the row was copied to another channel, tampered with,
    // or the deployment encryption key no longer matches.
    return "";
  }
}

export function sealProviderChannelPortraitCredential(
  channelId: string,
  credential: ProviderChannelPortraitCredentialInput,
): string {
  return sealSecret(encodeProviderChannelPortraitCredential(credential), portraitPurpose(channelId));
}

export function openProviderChannelPortraitCredential(channelId: string, ciphertext: unknown): string {
  const envelope = cleanString(ciphertext);
  if (!envelope || !isSealedSecret(envelope)) return "";
  try {
    const serialized = openSecret(envelope, portraitPurpose(channelId));
    const credential = parseProviderChannelPortraitCredential(serialized);
    return credential ? encodeProviderChannelPortraitCredential(credential) : "";
  } catch {
    return "";
  }
}

export function sealProviderChannelImageXReviewCredential(
  channelId: string,
  credential: Omit<ProviderChannelImageXReviewCredential, "version"> & { version?: string },
): string {
  return sealSecret(encodeProviderChannelImageXReviewCredential(credential), imageXReviewPurpose(channelId));
}

export function openProviderChannelImageXReviewCredential(channelId: string, ciphertext: unknown): string {
  const envelope = cleanString(ciphertext);
  if (!envelope || !isSealedSecret(envelope)) return "";
  try {
    const serialized = openSecret(envelope, imageXReviewPurpose(channelId));
    const credential = parseProviderChannelImageXReviewCredential(serialized);
    return credential ? encodeProviderChannelImageXReviewCredential(credential) : "";
  } catch {
    return "";
  }
}

export function hasSealedProviderChannelCredential(ciphertext: unknown): boolean {
  return isSealedSecret(cleanString(ciphertext));
}

export function readProviderChannelCredentialCiphertext(config: unknown): string {
  return cleanString(parseConfig(config)[PROVIDER_CHANNEL_CREDENTIAL_CONFIG_KEY]);
}

export function readProviderChannelPortraitCredentialCiphertext(config: unknown): string {
  return cleanString(parseConfig(config)[PROVIDER_CHANNEL_PORTRAIT_CREDENTIAL_CONFIG_KEY]);
}

export function readProviderChannelImageXReviewCredentialCiphertext(config: unknown): string {
  return cleanString(parseConfig(config)[PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_CONFIG_KEY]);
}

export function readProviderChannelPortraitCredentialMetadata(
  config: unknown,
): ProviderChannelPortraitCredentialMetadata {
  const parsed = parseConfig(config);
  const binding = cleanString(parsed[PROVIDER_CHANNEL_PORTRAIT_CREDENTIAL_BINDING_CONFIG_KEY]);
  return Object.freeze({
    enabled: parsed[PROVIDER_CHANNEL_PORTRAIT_ASSETS_ENABLED_CONFIG_KEY] === true,
    ciphertextPresent: isSealedSecret(cleanString(parsed[PROVIDER_CHANNEL_PORTRAIT_CREDENTIAL_CONFIG_KEY])),
    generation: safeGeneration(parsed[PROVIDER_CHANNEL_PORTRAIT_CREDENTIAL_GENERATION_CONFIG_KEY]),
    binding: PORTRAIT_BINDING_PATTERN.test(binding) ? binding : "",
  });
}

export function inspectProviderChannelPortraitCredential(
  channelId: string,
  config: unknown,
): ProviderChannelPortraitCredentialInspection {
  const metadata = readProviderChannelPortraitCredentialMetadata(config);
  const serializedCredential = openProviderChannelPortraitCredential(
    channelId,
    readProviderChannelPortraitCredentialCiphertext(config),
  );
  const credential = parseProviderChannelPortraitCredential(serializedCredential);
  let expectedBinding = "";
  try {
    expectedBinding = credential && metadata.generation > 0
      ? portraitCredentialBinding({
          channelId: cleanString(channelId),
          generation: metadata.generation,
          accessKeyId: portraitCredentialIdentity(credential),
        })
      : "";
  } catch {
    expectedBinding = "";
  }
  const configured = Boolean(
    metadata.ciphertextPresent
    && credential
    && expectedBinding
    && sameBinding(metadata.binding, expectedBinding)
    // Tokenhex uses the exact same account key for assets and generation.
    // A raw credential change cannot keep using the old account's asset IDs.
    && (credential.version !== TOKENHEX_PORTRAIT_CREDENTIAL_VERSION
      || sameOpaqueSecret(credential.bearerToken, openProviderChannelCredential(
        channelId, readProviderChannelCredentialCiphertext(config),
      ))),
  );
  return Object.freeze({
    ...metadata,
    configured,
    serializedCredential: configured ? serializedCredential : "",
    credential: configured ? credential : null,
  });
}

export function readProviderChannelImageXReviewCredentialMetadata(
  config: unknown,
): ProviderChannelImageXReviewCredentialMetadata {
  const parsed = parseConfig(config);
  const binding = cleanString(parsed[PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_BINDING_CONFIG_KEY]);
  return Object.freeze({
    enabled: parsed[PROVIDER_CHANNEL_IMAGEX_REVIEW_ENABLED_CONFIG_KEY] === true,
    ciphertextPresent: isSealedSecret(cleanString(parsed[PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_CONFIG_KEY])),
    generation: safeGeneration(parsed[PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_GENERATION_CONFIG_KEY]),
    binding: IMAGEX_REVIEW_BINDING_PATTERN.test(binding) ? binding : "",
  });
}

export function inspectProviderChannelImageXReviewCredential(
  channelId: string,
  config: unknown,
): ProviderChannelImageXReviewCredentialInspection {
  const metadata = readProviderChannelImageXReviewCredentialMetadata(config);
  const serializedCredential = openProviderChannelImageXReviewCredential(
    channelId,
    readProviderChannelImageXReviewCredentialCiphertext(config),
  );
  const credential = parseProviderChannelImageXReviewCredential(serializedCredential);
  let expectedBinding = "";
  try {
    expectedBinding = credential && metadata.generation > 0
      ? imageXReviewCredentialBinding({
          channelId: cleanString(channelId),
          generation: metadata.generation,
          serviceId: credential.serviceId,
          accessKeyId: credential.accessKeyId,
        })
      : "";
  } catch {
    expectedBinding = "";
  }
  const configured = Boolean(
    metadata.ciphertextPresent
    && credential
    && expectedBinding
    && sameImageXReviewBinding(metadata.binding, expectedBinding),
  );
  return Object.freeze({
    ...metadata,
    configured,
    serializedCredential: configured ? serializedCredential : "",
    credential: configured ? credential : null,
  });
}

export function withoutProviderChannelCredentialCiphertext(config: unknown): Record<string, unknown> {
  const output = parseConfig(config);
  delete output[PROVIDER_CHANNEL_CREDENTIAL_CONFIG_KEY];
  return output;
}

export function withoutProviderChannelReservedConfig(config: unknown): Record<string, unknown> {
  const output = parseConfig(config);
  for (const key of PROVIDER_CHANNEL_RESERVED_CONFIG_KEYS) delete output[key];
  for (const key of PROVIDER_CHANNEL_FORBIDDEN_CREDENTIAL_INPUT_KEYS) delete output[key];
  return output;
}

export function withProviderChannelPortraitAssetsEnabled(
  config: unknown,
  enabled: boolean,
): Record<string, unknown> {
  return {
    ...parseConfig(config),
    [PROVIDER_CHANNEL_PORTRAIT_ASSETS_ENABLED_CONFIG_KEY]: enabled,
  };
}

export function withProviderChannelImageXReviewEnabled(
  config: unknown,
  enabled: boolean,
): Record<string, unknown> {
  return {
    ...parseConfig(config),
    [PROVIDER_CHANNEL_IMAGEX_REVIEW_ENABLED_CONFIG_KEY]: enabled,
  };
}

export function withProviderChannelPortraitCredential(
  channelId: string,
  config: unknown,
  credential: ProviderChannelPortraitCredentialInput,
): Record<string, unknown> {
  const id = cleanString(channelId);
  if (!id) throw new Error("provider channel id is required for portrait credential encryption");
  const existing = parseConfig(config);
  const generation = safeGeneration(
    existing[PROVIDER_CHANNEL_PORTRAIT_CREDENTIAL_GENERATION_CONFIG_KEY],
  ) + 1;
  const serialized = encodeProviderChannelPortraitCredential(credential);
  const parsed = parseProviderChannelPortraitCredential(serialized);
  if (!parsed) throw new Error("portrait credential envelope is invalid");
  return {
    ...existing,
    [PROVIDER_CHANNEL_PORTRAIT_CREDENTIAL_CONFIG_KEY]: sealSecret(serialized, portraitPurpose(id)),
    [PROVIDER_CHANNEL_PORTRAIT_CREDENTIAL_GENERATION_CONFIG_KEY]: generation,
    [PROVIDER_CHANNEL_PORTRAIT_CREDENTIAL_BINDING_CONFIG_KEY]: portraitCredentialBinding({
      channelId: id,
      generation,
      accessKeyId: portraitCredentialIdentity(parsed),
    }),
  };
}

export function withProviderChannelImageXReviewCredential(
  channelId: string,
  config: unknown,
  credential: Omit<ProviderChannelImageXReviewCredential, "version"> & { version?: string },
): Record<string, unknown> {
  const id = cleanString(channelId);
  if (!id) throw new Error("provider channel id is required for ImageX review credential encryption");
  const existing = parseConfig(config);
  const generation = safeGeneration(
    existing[PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_GENERATION_CONFIG_KEY],
  ) + 1;
  const serialized = encodeProviderChannelImageXReviewCredential(credential);
  const parsed = parseProviderChannelImageXReviewCredential(serialized);
  if (!parsed) throw new Error("ImageX review credential envelope is invalid");
  return {
    ...existing,
    [PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_CONFIG_KEY]: sealSecret(serialized, imageXReviewPurpose(id)),
    [PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_GENERATION_CONFIG_KEY]: generation,
    [PROVIDER_CHANNEL_IMAGEX_REVIEW_CREDENTIAL_BINDING_CONFIG_KEY]: imageXReviewCredentialBinding({
      channelId: id,
      generation,
      serviceId: parsed.serviceId,
      accessKeyId: parsed.accessKeyId,
    }),
  };
}

export function rotateProviderChannelImageXReviewCredential(
  channelId: string,
  config: unknown,
  credential: Omit<ProviderChannelImageXReviewCredential, "version"> & { version?: string },
): Record<string, unknown> {
  return withProviderChannelImageXReviewCredential(channelId, config, credential);
}

export function withProviderChannelCredentialCiphertext(
  config: unknown,
  ciphertext: string,
): Record<string, unknown> {
  const envelope = cleanString(ciphertext);
  if (!isSealedSecret(envelope)) throw new Error("provider channel credential ciphertext is invalid");
  return {
    ...withoutProviderChannelCredentialCiphertext(config),
    [PROVIDER_CHANNEL_CREDENTIAL_CONFIG_KEY]: envelope,
  };
}

function sameOpaqueSecret(left: string, right: string): boolean {
  if (!left || !right) return false;
  const a = crypto.createHash("sha256").update(left).digest();
  const b = crypto.createHash("sha256").update(right).digest();
  return crypto.timingSafeEqual(a, b);
}

function portraitCredentialIdentity(credential: AnyProviderChannelPortraitCredential): string {
  return credential.version === TOKENHEX_PORTRAIT_CREDENTIAL_VERSION
    ? `tokenhex:${crypto.createHash("sha256").update(credential.bearerToken).digest("hex")}`
    : credential.accessKeyId;
}
