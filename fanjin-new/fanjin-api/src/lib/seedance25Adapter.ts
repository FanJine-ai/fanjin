import crypto from "node:crypto";
import { BYTEPLUS_SEEDANCE_25_MODEL_ID, DOMESTIC_SEEDANCE_25_MODEL_ID, isSeedance25ModelId, type Seedance25ModelId } from "./seedance25ModelIds";
import { hasPreparedReferenceTrim } from "./referenceMediaTrimProof";

import {
  SEEDANCE_25_CONTRACT_FAMILY,
  VIDEO_GENERATION_CAPABILITY_VERSION,
  VIDEO_GENERATION_POLICY_VERSION,
  VIDEO_GENERATION_REQUEST_VERSION,
  canonicalVideoGenerationRequest,
  preflightVideoGeneration,
  videoGenerationRequestDigest,
  type ProviderNeutralVideoCapability,
  type VideoGenerationRequest,
  type VideoInputPolicyDecision,
} from "@/lib/videoGenerationContract";
import type {
  WorkbenchModelCapability,
  WorkbenchVideoGenerationDirectory,
} from "@/lib/workbenchModelCatalog";
import type { TrustedVideoAssetPolicyEvidence } from "@/lib/videoAssetPolicy";
import { GenerationReferenceError } from "@/lib/generationReferenceError";
import {
  videoInputPricingTierForRequestPayload,
  resolveVideoInputPricing,
  type VideoInputPricingTier,
} from "@/lib/videoInputPricing";

export const SEEDANCE_25_MODEL_ID = DOMESTIC_SEEDANCE_25_MODEL_ID;
export { BYTEPLUS_SEEDANCE_25_MODEL_ID, isSeedance25ModelId };
export const BYTEPLUS_SEEDANCE_25_PROVIDER_ENDPOINT = "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks" as const;
export const BYTEPLUS_SEEDANCE_25_PRICING_READBACK_VERSION = "byteplus-seedance-2.5-pricing-readback/v1" as const;
export const BYTEPLUS_SEEDANCE_25_ADAPTER_MAPPING_VERSION = "fanjin-byteplus-seedance-2.5-adapter/v1" as const;
export const SEEDANCE_25_PROVIDER_ENDPOINT =
  "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks" as const;
export const SEEDANCE_25_PROVIDER_CONTRACT_VERSION =
  "volcano-ark-content-generation-task/2026-09-09" as const;
export const SEEDANCE_25_ADAPTER_MAPPING_VERSION =
  "fanjin-seedance-2.5-generate-adapter/v1" as const;
export const SEEDANCE_25_RELAY_ADAPTER_BINDING_VERSION =
  "relay-video-provider-adapter-binding/v1" as const;
export const SEEDANCE_25_PRICING_REVISION =
  "volcano-seedance-2.5-online-2026-09-09" as const;
export const SEEDANCE_25_PRICING_CONTRACT =
  "volcano-seedance-2.5-completion-tokens/v2" as const;
export const SEEDANCE_25_AUTHORITATIVE_USAGE_PATH =
  "usage.completion_tokens" as const;
export const SEEDANCE_25_PRICING_READBACK_VERSION =
  "seedance-2.5-pricing-readback/v2" as const;
export const SEEDANCE_25_COMPLIANCE_POLICY_VERSION =
  "volcano-seedance-2.5-portrait-policy-2026-08-07" as const;
export const SEEDANCE_25_FRAME_RATE = 24 as const;
export const SEEDANCE_25_NATIVE_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
export const SEEDANCE_25_ASPECT_RATIOS = [
  "21:9",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
] as const;
export const SEEDANCE_25_INPUT_LIMITS = Object.freeze({
  total: 50,
  image: 30,
  video: 10,
  audio: 10,
});
/**
 * Ordinary generation retains a fixed ratio. Automatic duration is an explicit
 * runtime extension; reference requests pin task type so -1 does not silently
 * opt into the separate edit/extend operations.
 */
export const SEEDANCE_25_V1_SAFE_INPUT_LIMITS = Object.freeze({
  total: 50,
  image: 30,
  video: 10,
  audio: 10,
});

/**
 * Retail ledger atoms per token: 70/42 CNY per million tokens at list price.
 * One yuan remains 1 billion ledger atoms; the public GU denomination is 1:10.
 * Production admission must read back the exact persisted rule.
 */
export const SEEDANCE_25_TOKEN_PRICES = Object.freeze({
  withoutVideoInput: 70_000,
  withVideoInput: 42_000,
});
// CNY and GU have separate units; certification records upstream micro-CNY.
export const SEEDANCE_25_UPSTREAM_TOKEN_PRICES = Object.freeze({
  withoutVideoInput: 70,
  withVideoInput: 42,
});
export const SEEDANCE_25_RESOLUTION_TOKEN_PRICES = Object.freeze({
  "480p": SEEDANCE_25_TOKEN_PRICES,
  "720p": SEEDANCE_25_TOKEN_PRICES,
  "1080p": Object.freeze({ withoutVideoInput: 77_000, withVideoInput: 46_000 }),
});

export const SEEDANCE_25_CERTIFICATION_PROBE_VERSION =
  "seedance-2.5-certification-probe/v1" as const;
export const SEEDANCE_25_CERTIFICATION_PROBE_PROMPT =
  "A paper airplane glides through a clear blue sky, static camera, clean background." as const;
export const SEEDANCE_25_CERTIFICATION_PROBE_PROMPT_DIGEST =
  "sha256:5943e98380a39dc660f42198dc893d3623b0e45f1caa38ae1d01024360fe2a7f" as const;
export const SEEDANCE_25_CERTIFICATION_PROBE_MAX_VALIDITY_MS = 30 * 60 * 1_000;
export const SEEDANCE_25_CERTIFICATION_PROBE_REQUEST_ID_PREFIX =
  "seedance25-certification:" as const;

export type Seedance25CertificationProbePermit = {
  version: typeof SEEDANCE_25_CERTIFICATION_PROBE_VERSION;
  probeId: string;
  workspaceId: string;
  projectId: string;
  adminUserId: string;
  promptDigest: typeof SEEDANCE_25_CERTIFICATION_PROBE_PROMPT_DIGEST;
  createdAt: string;
  expiresAt: string;
  routeId: string;
  pricingRuleId: string;
  channelId: string;
};

const SEEDANCE_25_CERTIFICATION_PROBE_KEYS = [
  "version",
  "probeId",
  "workspaceId",
  "projectId",
  "adminUserId",
  "promptDigest",
  "createdAt",
  "expiresAt",
  "routeId",
  "pricingRuleId",
  "channelId",
] as const;
const SEEDANCE_25_PROBE_UUID_V4_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SEEDANCE_25_PROBE_SAFE_OPAQUE_ID_PATTERN =
  /^[^\u0000-\u001f\u007f\s]{1,200}$/u;
const SEEDANCE_25_PROBE_POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/u;
const SEEDANCE_25_PROBE_UTC_RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function exactObjectKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function parsePositiveDecimalId(value: unknown): number | null {
  if (
    typeof value !== "string"
    || !SEEDANCE_25_PROBE_POSITIVE_DECIMAL_PATTERN.test(value)
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseProbeTimestamp(value: unknown): number | null {
  if (
    typeof value !== "string"
    || !SEEDANCE_25_PROBE_UTC_RFC3339_PATTERN.test(value)
  ) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed)
    && parsed > 0
    && new Date(parsed).toISOString() === value
    ? parsed
    : null;
}

/**
 * Validates the exact operator-written routeConfig permit. The permit is a
 * short-lived immutable capability document; unknown fields, coercion and
 * non-canonical identifiers are rejected instead of being ignored.
 */
export function assertSeedance25CertificationProbePermit(
  value: unknown,
  now = Date.now(),
): Seedance25CertificationProbePermit {
  const candidate = pricingRecord(value);
  const createdAt = parseProbeTimestamp(candidate?.createdAt);
  const expiresAt = parseProbeTimestamp(candidate?.expiresAt);
  if (
    !candidate
    || !exactObjectKeys(candidate, SEEDANCE_25_CERTIFICATION_PROBE_KEYS)
    || candidate.version !== SEEDANCE_25_CERTIFICATION_PROBE_VERSION
    || typeof candidate.probeId !== "string"
    || !SEEDANCE_25_PROBE_UUID_V4_PATTERN.test(candidate.probeId)
    || typeof candidate.workspaceId !== "string"
    || !SEEDANCE_25_PROBE_SAFE_OPAQUE_ID_PATTERN.test(candidate.workspaceId)
    || typeof candidate.routeId !== "string"
    || !SEEDANCE_25_PROBE_SAFE_OPAQUE_ID_PATTERN.test(candidate.routeId)
    || typeof candidate.pricingRuleId !== "string"
    || !SEEDANCE_25_PROBE_SAFE_OPAQUE_ID_PATTERN.test(candidate.pricingRuleId)
    || typeof candidate.channelId !== "string"
    || !SEEDANCE_25_PROBE_SAFE_OPAQUE_ID_PATTERN.test(candidate.channelId)
    || parsePositiveDecimalId(candidate.projectId) === null
    || parsePositiveDecimalId(candidate.adminUserId) === null
    || candidate.promptDigest !== SEEDANCE_25_CERTIFICATION_PROBE_PROMPT_DIGEST
    || createdAt === null
    || expiresAt === null
    || !Number.isSafeInteger(now)
    || now < createdAt
    || expiresAt <= now
    || expiresAt <= createdAt
    || expiresAt - createdAt > SEEDANCE_25_CERTIFICATION_PROBE_MAX_VALIDITY_MS
  ) {
    fail(
      "seedance25_certification_probe_permit_invalid",
      "Seedance 2.5 首次认证探针 permit 无效、已过期或已被篡改",
      409,
    );
  }
  return {
    version: SEEDANCE_25_CERTIFICATION_PROBE_VERSION,
    probeId: candidate.probeId,
    workspaceId: candidate.workspaceId,
    projectId: candidate.projectId as string,
    adminUserId: candidate.adminUserId as string,
    promptDigest: SEEDANCE_25_CERTIFICATION_PROBE_PROMPT_DIGEST,
    createdAt: candidate.createdAt as string,
    expiresAt: candidate.expiresAt as string,
    routeId: candidate.routeId,
    pricingRuleId: candidate.pricingRuleId,
    channelId: candidate.channelId,
  };
}

export type Seedance25PricingReadbackBinding = {
  version: typeof SEEDANCE_25_PRICING_READBACK_VERSION;
  pricingRevision: typeof SEEDANCE_25_PRICING_REVISION;
  pricingContract: typeof SEEDANCE_25_PRICING_CONTRACT;
  pricingReadbackSha256: string;
  authoritativeUsagePath: typeof SEEDANCE_25_AUTHORITATIVE_USAGE_PATH;
  provider: "volcano";
  model: typeof SEEDANCE_25_MODEL_ID;
  unit: "token";
  currency: "GU";
  baseUnitPriceMicros: typeof SEEDANCE_25_TOKEN_PRICES.withoutVideoInput;
  withoutVideoInputUnitPriceMicros: typeof SEEDANCE_25_TOKEN_PRICES.withoutVideoInput;
  withVideoInputUnitPriceMicros: typeof SEEDANCE_25_TOKEN_PRICES.withVideoInput;
  resolutionTokenPrices: typeof SEEDANCE_25_RESOLUTION_TOKEN_PRICES;
  reservationUpperBoundTokens: number;
};

export type BytePlusSeedance25PricingReadbackBinding = {
  version: typeof BYTEPLUS_SEEDANCE_25_PRICING_READBACK_VERSION;
  pricingReadbackSha256: string;
  provider: "volcano";
  model: typeof BYTEPLUS_SEEDANCE_25_MODEL_ID;
  unit: "token";
  currency: "GU";
  baseUnitPriceMicros: number;
  authoritativeUsagePath: typeof SEEDANCE_25_AUTHORITATIVE_USAGE_PATH;
  reservationUpperBoundTokens: number;
  resolutionTokenPrices: Record<"480p" | "720p" | "1080p", { withoutVideoInput: number; withVideoInput: number }>;
};

export type Seedance25AnyPricingReadbackBinding = Seedance25PricingReadbackBinding | BytePlusSeedance25PricingReadbackBinding;

const OFFICIAL_SCHEMA_SNAPSHOT = Object.freeze({
  sourceUpdatedAt: "2026-09-09",
  model: SEEDANCE_25_MODEL_ID,
  endpoint: SEEDANCE_25_PROVIDER_ENDPOINT,
  operation: "generate",
  contentTypes: ["text", "image_url", "video_url", "audio_url"],
  contentRoles: ["reference_image", "reference_video", "reference_audio"],
  resolutions: [...SEEDANCE_25_NATIVE_RESOLUTIONS],
  frameRate: SEEDANCE_25_FRAME_RATE,
  durationSeconds: { min: 4, max: 30, step: 1 },
  inputLimits: SEEDANCE_25_INPUT_LIMITS,
  v1TaskShape: "fixed-ratio-positive-duration-reference-generation",
  generateAudio: true,
  responseUsage: "usage.completion_tokens",
});

export const SEEDANCE_25_PROVIDER_SCHEMA_SHA256 = crypto
  .createHash("sha256")
  .update(JSON.stringify(OFFICIAL_SCHEMA_SNAPSHOT))
  .digest("hex");

const GENERIC_REFERENCE_ROLES = ["subject", "style", "storyboard"] as const;

export class Seedance25AdapterError extends GenerationReferenceError {
  readonly statusCode: number;

  constructor(code: string, message: string, status = 422) {
    super(status, code, message);
    this.name = "Seedance25AdapterError";
    this.statusCode = status;
  }
}

function fail(code: string, message: string, status = 422): never {
  throw new Seedance25AdapterError(code, message, status);
}

function pricingRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function positiveSafeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function seedance25PricingReadbackDocument(input: {
  provider: unknown;
  model: unknown;
  unit: unknown;
  currency: unknown;
  baseUnitPriceMicros: unknown;
  ruleConfig: unknown;
}): Omit<Seedance25PricingReadbackBinding, "pricingReadbackSha256"> {
  const config = pricingRecord(input.ruleConfig);
  const tiers = pricingRecord(config?.videoInputPricing);
  const withoutVideoInput = pricingRecord(tiers?.withoutVideoInput);
  const withVideoInput = pricingRecord(tiers?.withVideoInput);
  const reservationUpperBoundTokens = positiveSafeInteger(
    config?.reservationUpperBoundTokens,
  );
  const withoutReservation = positiveSafeInteger(
    withoutVideoInput?.reservationUpperBoundTokens,
  );
  const withReservation = positiveSafeInteger(
    withVideoInput?.reservationUpperBoundTokens,
  );
  const baseMultiplier = Number(config?.multiplier ?? 1);
  const baseMinimum = Number(config?.minimumMicros ?? 0);
  const withoutMultiplier = Number(withoutVideoInput?.multiplier ?? baseMultiplier);
  const withMultiplier = Number(withVideoInput?.multiplier ?? baseMultiplier);
  const withoutMinimum = Number(withoutVideoInput?.minimumMicros ?? baseMinimum);
  const withMinimum = Number(withVideoInput?.minimumMicros ?? baseMinimum);
  if (
    input.provider !== "volcano"
    || input.model !== SEEDANCE_25_MODEL_ID
    || input.unit !== "token"
    || String(input.currency || "").trim().toUpperCase() !== "GU"
    || Number(input.baseUnitPriceMicros) !== SEEDANCE_25_TOKEN_PRICES.withoutVideoInput
    || !config
    || config.pricingRevision !== SEEDANCE_25_PRICING_REVISION
    || config.pricingContract !== SEEDANCE_25_PRICING_CONTRACT
    || config.authoritativeUsagePath !== SEEDANCE_25_AUTHORITATIVE_USAGE_PATH
    || !reservationUpperBoundTokens
    || !withoutVideoInput
    || !withVideoInput
    || Number(withoutVideoInput.unitPriceMicros) !== SEEDANCE_25_TOKEN_PRICES.withoutVideoInput
    || Number(withVideoInput.unitPriceMicros) !== SEEDANCE_25_TOKEN_PRICES.withVideoInput
    || withoutReservation !== reservationUpperBoundTokens
    || withReservation !== reservationUpperBoundTokens
    || baseMultiplier !== 1
    || withoutMultiplier !== 1
    || withMultiplier !== 1
    || baseMinimum !== 0
    || withoutMinimum !== 0
    || withMinimum !== 0
  ) {
    fail(
      "seedance25_pricing_readback_invalid",
      "Seedance 2.5 定价单位、官方刊例价或预占上限配置不一致",
      409,
    );
  }
  const resolutionPrices = pricingRecord(config.videoResolutionPricing);
  if (!resolutionPrices || !exactStringSet(Object.keys(resolutionPrices), SEEDANCE_25_NATIVE_RESOLUTIONS)) {
    fail("seedance25_pricing_readback_invalid", "Seedance 2.5 必须配置全部官方分辨率价格", 409);
  }
  for (const resolution of SEEDANCE_25_NATIVE_RESOLUTIONS) {
    for (const hasVideo of [false, true]) {
      const price = resolveVideoInputPricing({
        ruleConfig: config,
        baseUnitPriceMicros: input.baseUnitPriceMicros,
        requestPayload: { resolution, content: hasVideo ? [{ type: "video_url" }] : [] },
      });
      const expected = SEEDANCE_25_RESOLUTION_TOKEN_PRICES[resolution];
      if (price.unitPriceMicros !== (hasVideo ? expected.withVideoInput : expected.withoutVideoInput)
        || price.multiplier !== 1 || price.minimumMicros !== 0
        || price.reservationUpperBoundTokens !== reservationUpperBoundTokens) {
        fail("seedance25_pricing_readback_invalid", `Seedance 2.5 ${resolution} 官方价格配置不一致`, 409);
      }
    }
  }
  return {
    version: SEEDANCE_25_PRICING_READBACK_VERSION,
    pricingRevision: SEEDANCE_25_PRICING_REVISION,
    pricingContract: SEEDANCE_25_PRICING_CONTRACT,
    authoritativeUsagePath: SEEDANCE_25_AUTHORITATIVE_USAGE_PATH,
    provider: "volcano",
    model: SEEDANCE_25_MODEL_ID,
    unit: "token",
    currency: "GU",
    baseUnitPriceMicros: SEEDANCE_25_TOKEN_PRICES.withoutVideoInput,
    withoutVideoInputUnitPriceMicros: SEEDANCE_25_TOKEN_PRICES.withoutVideoInput,
    withVideoInputUnitPriceMicros: SEEDANCE_25_TOKEN_PRICES.withVideoInput,
    resolutionTokenPrices: SEEDANCE_25_RESOLUTION_TOKEN_PRICES,
    reservationUpperBoundTokens,
  };
}

function seedance25PricingReadbackDigest(
  document: Omit<Seedance25PricingReadbackBinding, "pricingReadbackSha256">,
): string {
  return crypto.createHash("sha256").update(JSON.stringify(document)).digest("hex");
}

/**
 * Converts a persisted provider/model pricing rule into the immutable facts
 * carried from catalog resolution through the Relay reservation boundary.
 * The operator-declared digest is mandatory, so a one-price legacy fallback
 * can never masquerade as the formal Seedance 2.5 price contract.
 */
export function assertSeedance25PricingRuleReadback(input: {
  provider: unknown;
  model: unknown;
  unit: unknown;
  currency: unknown;
  baseUnitPriceMicros: unknown;
  ruleConfig: unknown;
}): Seedance25PricingReadbackBinding {
  const document = seedance25PricingReadbackDocument(input);
  const pricingReadbackSha256 = seedance25PricingReadbackDigest(document);
  const config = pricingRecord(input.ruleConfig);
  if (config?.pricingReadbackSha256 !== pricingReadbackSha256) {
    fail(
      "seedance25_pricing_readback_digest_mismatch",
      "Seedance 2.5 定价读回摘要与正式双档合同不一致",
      409,
    );
  }
  return { ...document, pricingReadbackSha256 };
}

export function assertSeedance25PricingBinding(
  value: unknown,
): Seedance25PricingReadbackBinding {
  const binding = pricingRecord(value);
  if (!binding) {
    fail("seedance25_pricing_binding_required", "Seedance 2.5 Adapter 缺少可信定价读回绑定", 409);
  }
  const { pricingReadbackSha256, ...document } = binding;
  if (
    !/^[a-f0-9]{64}$/u.test(String(pricingReadbackSha256 || ""))
    || seedance25PricingReadbackDigest(
      document as Omit<Seedance25PricingReadbackBinding, "pricingReadbackSha256">,
    ) !== pricingReadbackSha256
  ) {
    fail("seedance25_pricing_binding_invalid", "Seedance 2.5 Adapter 定价绑定摘要无效", 409);
  }
  // Reuse the persisted-rule validator against a reconstructed exact config;
  // this also rejects extra/missing or type-coerced binding facts.
  const reconstructedConfig = buildSeedance25TokenPricingRuleConfig({
    reservationUpperBoundTokens: Number(binding.reservationUpperBoundTokens),
  });
  const expected = assertSeedance25PricingRuleReadback({
    provider: "volcano",
    model: SEEDANCE_25_MODEL_ID,
    unit: "token",
    currency: "GU",
    baseUnitPriceMicros: SEEDANCE_25_TOKEN_PRICES.withoutVideoInput,
    ruleConfig: reconstructedConfig,
  });
  if (JSON.stringify(binding) !== JSON.stringify(expected)) {
    fail("seedance25_pricing_binding_invalid", "Seedance 2.5 Adapter 定价绑定字段不一致", 409);
  }
  return expected;
}

const BYTEPLUS_PRICING_CONTRACT = "byteplus-seedance-2.5-completion-tokens/v1";
// Local wallet exposure policy for 30 s output + 30 s video input at 1080p,
// using the conservative reservation estimator. This is not an upstream limit.
const BYTEPLUS_MIN_FULL_DURATION_RESERVATION_TOKENS = 3_207_600;

function bytePlusPricingDocument(input: {
  provider: unknown; model: unknown; unit: unknown; currency: unknown;
  baseUnitPriceMicros: unknown; ruleConfig: unknown;
}): Omit<BytePlusSeedance25PricingReadbackBinding, "pricingReadbackSha256"> {
  const config = pricingRecord(input.ruleConfig);
  const cap = positiveSafeInteger(config?.reservationUpperBoundTokens);
  const base = positiveSafeInteger(input.baseUnitPriceMicros);
  const resolutionPricing = pricingRecord(config?.videoResolutionPricing);
  if (input.provider !== "volcano" || input.model !== BYTEPLUS_SEEDANCE_25_MODEL_ID
    || input.unit !== "token" || String(input.currency || "").toUpperCase() !== "GU"
    || !base || !config || config.pricingContract !== BYTEPLUS_PRICING_CONTRACT
    || config.authoritativeUsagePath !== SEEDANCE_25_AUTHORITATIVE_USAGE_PATH
    || config.defaultResolution !== "720p"
    || !cap || cap < BYTEPLUS_MIN_FULL_DURATION_RESERVATION_TOKENS
    || !resolutionPricing || !exactStringSet(Object.keys(resolutionPricing), SEEDANCE_25_NATIVE_RESOLUTIONS)
    || Number(config.multiplier ?? 1) !== 1 || Number(config.minimumMicros ?? 0) !== 0) {
    fail("byteplus_seedance25_pricing_invalid", "海外 Seedance 2.5 缺少完整分辨率价格或正式时长的 token 预占上限", 409);
  }
  const resolutionTokenPrices = {} as BytePlusSeedance25PricingReadbackBinding["resolutionTokenPrices"];
  for (const resolution of SEEDANCE_25_NATIVE_RESOLUTIONS) {
    const without = resolveVideoInputPricing({ ruleConfig: config, baseUnitPriceMicros: base,
      requestPayload: { resolution, content: [] } });
    const withVideo = resolveVideoInputPricing({ ruleConfig: config, baseUnitPriceMicros: base,
      requestPayload: { resolution, content: [{ type: "video_url" }] } });
    if (!without.configured || !withVideo.configured
      || !positiveSafeInteger(without.unitPriceMicros) || !positiveSafeInteger(withVideo.unitPriceMicros)
      || without.reservationUpperBoundTokens !== cap || withVideo.reservationUpperBoundTokens !== cap
      || without.multiplier !== 1 || withVideo.multiplier !== 1
      || without.minimumMicros !== 0 || withVideo.minimumMicros !== 0) {
      fail("byteplus_seedance25_pricing_invalid", `海外 Seedance 2.5 ${resolution} 定价分档不完整`, 409);
    }
    resolutionTokenPrices[resolution] = {
      withoutVideoInput: without.unitPriceMicros,
      withVideoInput: withVideo.unitPriceMicros,
    };
  }
  if (resolutionTokenPrices["720p"].withoutVideoInput !== base) {
    fail("byteplus_seedance25_pricing_invalid", "海外 Seedance 2.5 基准价与 720p 无视频档不一致", 409);
  }
  return {
    version: BYTEPLUS_SEEDANCE_25_PRICING_READBACK_VERSION,
    provider: "volcano", model: BYTEPLUS_SEEDANCE_25_MODEL_ID,
    unit: "token", currency: "GU", baseUnitPriceMicros: base,
    authoritativeUsagePath: SEEDANCE_25_AUTHORITATIVE_USAGE_PATH,
    reservationUpperBoundTokens: cap,
    resolutionTokenPrices,
  };
}

function bytePlusPricingDigest(document: Omit<BytePlusSeedance25PricingReadbackBinding, "pricingReadbackSha256">): string {
  return crypto.createHash("sha256").update(JSON.stringify(document)).digest("hex");
}

export function assertBytePlusSeedance25PricingRuleReadback(input: {
  provider: unknown; model: unknown; unit: unknown; currency: unknown;
  baseUnitPriceMicros: unknown; ruleConfig: unknown;
}): BytePlusSeedance25PricingReadbackBinding {
  const document = bytePlusPricingDocument(input);
  const pricingReadbackSha256 = bytePlusPricingDigest(document);
  if (pricingRecord(input.ruleConfig)?.pricingReadbackSha256 !== pricingReadbackSha256) {
    fail("byteplus_seedance25_pricing_digest_mismatch", "海外 Seedance 2.5 价格读回摘要不一致", 409);
  }
  return { ...document, pricingReadbackSha256 };
}

export function assertBytePlusSeedance25PricingBinding(value: unknown): BytePlusSeedance25PricingReadbackBinding {
  const binding = pricingRecord(value);
  if (!binding || !exactObjectKeys(binding, ["version", "pricingReadbackSha256", "provider", "model", "unit", "currency",
    "baseUnitPriceMicros", "authoritativeUsagePath", "reservationUpperBoundTokens", "resolutionTokenPrices"])) {
    fail("byteplus_seedance25_pricing_binding_invalid", "海外 Seedance 2.5 定价绑定字段无效", 409);
  }
  const { pricingReadbackSha256, ...document } = binding;
  const prices = pricingRecord(binding.resolutionTokenPrices);
  if (binding.version !== BYTEPLUS_SEEDANCE_25_PRICING_READBACK_VERSION
    || binding.provider !== "volcano" || binding.model !== BYTEPLUS_SEEDANCE_25_MODEL_ID
    || binding.unit !== "token" || binding.currency !== "GU"
    || binding.authoritativeUsagePath !== SEEDANCE_25_AUTHORITATIVE_USAGE_PATH
    || !positiveSafeInteger(binding.baseUnitPriceMicros)
    || !positiveSafeInteger(binding.reservationUpperBoundTokens)
    || Number(binding.reservationUpperBoundTokens) < BYTEPLUS_MIN_FULL_DURATION_RESERVATION_TOKENS
    || !prices || !exactStringSet(Object.keys(prices), SEEDANCE_25_NATIVE_RESOLUTIONS)
    || SEEDANCE_25_NATIVE_RESOLUTIONS.some((resolution) => {
      const tier = pricingRecord(prices[resolution]);
      return !tier || !exactObjectKeys(tier, ["withoutVideoInput", "withVideoInput"])
        || !positiveSafeInteger(tier.withoutVideoInput) || !positiveSafeInteger(tier.withVideoInput);
    })
    || !/^[a-f0-9]{64}$/u.test(String(pricingReadbackSha256 || ""))
    || bytePlusPricingDigest(document as Omit<BytePlusSeedance25PricingReadbackBinding, "pricingReadbackSha256">) !== pricingReadbackSha256) {
    fail("byteplus_seedance25_pricing_binding_invalid", "海外 Seedance 2.5 定价绑定摘要无效", 409);
  }
  return binding as BytePlusSeedance25PricingReadbackBinding;
}

/** Operator supplies actual account prices; this builder never imports domestic list prices. */
export function buildBytePlusSeedance25PricingRuleConfig(input: {
  existingRuleConfig?: Record<string, unknown>;
  baseUnitPriceMicros: number;
  reservationUpperBoundTokens: number;
  resolutionTokenPrices: BytePlusSeedance25PricingReadbackBinding["resolutionTokenPrices"];
}): Record<string, unknown> {
  const ruleConfig = {
    ...input.existingRuleConfig,
    pricingContract: BYTEPLUS_PRICING_CONTRACT,
    authoritativeUsagePath: SEEDANCE_25_AUTHORITATIVE_USAGE_PATH,
    defaultResolution: "720p",
    multiplier: 1,
    minimumMicros: 0,
    reservationUpperBoundTokens: input.reservationUpperBoundTokens,
    videoInputPricing: {
      withoutVideoInput: { unitPriceMicros: input.baseUnitPriceMicros, reservationUpperBoundTokens: input.reservationUpperBoundTokens },
      withVideoInput: { unitPriceMicros: input.resolutionTokenPrices["720p"].withVideoInput, reservationUpperBoundTokens: input.reservationUpperBoundTokens },
    },
    videoResolutionPricing: Object.fromEntries(SEEDANCE_25_NATIVE_RESOLUTIONS.map((resolution) => [resolution, {
      unitPriceMicros: input.resolutionTokenPrices[resolution].withoutVideoInput,
      reservationUpperBoundTokens: input.reservationUpperBoundTokens,
      videoInputPricing: {
        withoutVideoInput: { unitPriceMicros: input.resolutionTokenPrices[resolution].withoutVideoInput, reservationUpperBoundTokens: input.reservationUpperBoundTokens },
        withVideoInput: { unitPriceMicros: input.resolutionTokenPrices[resolution].withVideoInput, reservationUpperBoundTokens: input.reservationUpperBoundTokens },
      },
    }])),
  };
  const document = bytePlusPricingDocument({ provider: "volcano", model: BYTEPLUS_SEEDANCE_25_MODEL_ID,
    unit: "token", currency: "GU", baseUnitPriceMicros: input.baseUnitPriceMicros, ruleConfig });
  return { ...ruleConfig, pricingReadbackSha256: bytePlusPricingDigest(document) };
}

function exactStringSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && [...actual].sort().every((item, index) => item === [...expected].sort()[index]);
}

export function verifiedSeedance25Capability(
  featureFlagEnabled: boolean,
  videoExtensionEnabled = false,
  videoEditEnabled = false,
): ProviderNeutralVideoCapability {
  return {
    version: VIDEO_GENERATION_CAPABILITY_VERSION,
    contractFamily: SEEDANCE_25_CONTRACT_FAMILY,
    state: "verified",
    unavailableReason: featureFlagEnabled ? null : "等待账号目录、计费预占上限与真实任务验收",
    providerContractVersion: SEEDANCE_25_PROVIDER_CONTRACT_VERSION,
    providerSchemaSha256: SEEDANCE_25_PROVIDER_SCHEMA_SHA256,
    adapterMappingVersion: SEEDANCE_25_ADAPTER_MAPPING_VERSION,
    pricingRevision: SEEDANCE_25_PRICING_REVISION,
    compliancePolicyVersion: SEEDANCE_25_COMPLIANCE_POLICY_VERSION,
    featureFlagEnabled,
    operations: [
      {
        operation: "generate",
        enabled: true,
        durationSeconds: { min: 4, max: 30, step: 1 },
        nativeResolutions: [...SEEDANCE_25_NATIVE_RESOLUTIONS],
        fulfillmentResolutions: [],
      },
      {
        operation: "extend",
        enabled: videoExtensionEnabled,
        durationSeconds: { min: 4, max: 30, step: 1 },
        nativeResolutions: [...SEEDANCE_25_NATIVE_RESOLUTIONS],
        fulfillmentResolutions: [],
      },
      {
        operation: "edit",
        enabled: videoEditEnabled,
        durationSeconds: { min: 4, max: 30, step: 1, auto: true },
        nativeResolutions: [...SEEDANCE_25_NATIVE_RESOLUTIONS],
        fulfillmentResolutions: [],
      },
    ],
    inputSlots: [
      {
        id: "reference_images",
        label: "参考图片",
        mediaType: "image",
        roles: [...GENERIC_REFERENCE_ROLES],
        operations: ["generate", ...(videoExtensionEnabled ? ["extend" as const] : []), ...(videoEditEnabled ? ["edit" as const] : [])],
        min: 0,
        max: SEEDANCE_25_INPUT_LIMITS.image,
        allowDuplicateAsset: false,
        supportsTrim: false,
      },
      {
        id: "reference_videos",
        label: "参考视频",
        mediaType: "video",
        roles: [...GENERIC_REFERENCE_ROLES],
        operations: ["generate", ...(videoExtensionEnabled ? ["extend" as const] : []), ...(videoEditEnabled ? ["edit" as const] : [])],
        min: 0,
        max: SEEDANCE_25_INPUT_LIMITS.video,
        allowDuplicateAsset: false,
        supportsTrim: false,
      },
      {
        id: "reference_audio",
        label: "参考音频",
        mediaType: "audio",
        roles: [...GENERIC_REFERENCE_ROLES],
        operations: ["generate", ...(videoExtensionEnabled ? ["extend" as const] : []), ...(videoEditEnabled ? ["edit" as const] : [])],
        min: 0,
        max: SEEDANCE_25_INPUT_LIMITS.audio,
        allowDuplicateAsset: false,
        supportsTrim: false,
      },
    ],
    totalInputLimit: SEEDANCE_25_V1_SAFE_INPUT_LIMITS.total,
    mediaTypeLimits: {
      image: SEEDANCE_25_V1_SAFE_INPUT_LIMITS.image,
      video: SEEDANCE_25_V1_SAFE_INPUT_LIMITS.video,
      audio: SEEDANCE_25_V1_SAFE_INPUT_LIMITS.audio,
    },
    supportsGenerateAudio: true,
    supportsPreserveSourceAudio: false,
    supportsMask: false,
    supportsTimeRange: false,
    supportsSourceTaskContinuation: false,
  };
}

const BYTEPLUS_SEEDANCE_25_PROVIDER_SCHEMA_SHA256 = crypto.createHash("sha256")
  .update(JSON.stringify({
    model: BYTEPLUS_SEEDANCE_25_MODEL_ID,
    endpoint: BYTEPLUS_SEEDANCE_25_PROVIDER_ENDPOINT,
    resolutions: SEEDANCE_25_NATIVE_RESOLUTIONS,
    durations: [4, 30, -1],
    inputLimits: SEEDANCE_25_INPUT_LIMITS,
    outputFormats: ["mp4", "mov"],
    operations: ["generate", "edit", "extend"],
  })).digest("hex");

export function verifiedBytePlusSeedance25Capability(
  featureFlagEnabled: boolean,
  videoExtensionEnabled = true,
  videoEditEnabled = true,
): ProviderNeutralVideoCapability {
  const domesticShape = verifiedSeedance25Capability(featureFlagEnabled, videoExtensionEnabled, videoEditEnabled);
  return {
    ...domesticShape,
    providerContractVersion: "byteplus-modelark-content-generation-task/2026-09-30",
    providerSchemaSha256: BYTEPLUS_SEEDANCE_25_PROVIDER_SCHEMA_SHA256,
    adapterMappingVersion: BYTEPLUS_SEEDANCE_25_ADAPTER_MAPPING_VERSION,
    pricingRevision: "byteplus-seedance-2.5-account-price/v1",
    compliancePolicyVersion: "byteplus-seedance-2.5-asset-policy/v1",
    operations: domesticShape.operations.map((operation) => ({
      ...operation,
      durationSeconds: {
        ...operation.durationSeconds,
        auto: true,
      },
    })),
    inputSlots: domesticShape.inputSlots.map((slot) => slot.mediaType === "image"
      ? { ...slot, roles: [...slot.roles, "first_frame", "last_frame"] }
      : slot),
  };
}

export function buildSeedance25TokenPricingRuleConfig(input: {
  reservationUpperBoundTokens: number;
}): Record<string, unknown> {
  if (
    !Number.isSafeInteger(input.reservationUpperBoundTokens)
    || input.reservationUpperBoundTokens <= 0
  ) {
    throw new Seedance25AdapterError(
      "seedance25_reservation_upper_bound_required",
      "Seedance 2.5 上线前必须由管理员提供正式 token 预占上限，禁止猜测",
      409,
    );
  }
  const ruleConfig: Record<string, unknown> = {
    minimumMicros: 0,
    pricingRevision: SEEDANCE_25_PRICING_REVISION,
    pricingContract: SEEDANCE_25_PRICING_CONTRACT,
    authoritativeUsagePath: SEEDANCE_25_AUTHORITATIVE_USAGE_PATH,
    reservationUpperBoundTokens: input.reservationUpperBoundTokens,
    defaultResolution: "720p",
    videoResolutionPricing: Object.fromEntries(Object.entries(SEEDANCE_25_RESOLUTION_TOKEN_PRICES).map(([resolution, prices]) => [resolution, {
      unitPriceMicros: prices.withoutVideoInput,
      reservationUpperBoundTokens: input.reservationUpperBoundTokens,
      videoInputPricing: {
        withoutVideoInput: { unitPriceMicros: prices.withoutVideoInput, reservationUpperBoundTokens: input.reservationUpperBoundTokens },
        withVideoInput: { unitPriceMicros: prices.withVideoInput, reservationUpperBoundTokens: input.reservationUpperBoundTokens },
      },
    }])),
    videoInputPricing: {
      withoutVideoInput: {
        unitPriceMicros: SEEDANCE_25_TOKEN_PRICES.withoutVideoInput,
        reservationUpperBoundTokens: input.reservationUpperBoundTokens,
      },
      withVideoInput: {
        unitPriceMicros: SEEDANCE_25_TOKEN_PRICES.withVideoInput,
        reservationUpperBoundTokens: input.reservationUpperBoundTokens,
      },
    },
  };
  const document = seedance25PricingReadbackDocument({
    provider: "volcano",
    model: SEEDANCE_25_MODEL_ID,
    unit: "token",
    currency: "GU",
    baseUnitPriceMicros: SEEDANCE_25_TOKEN_PRICES.withoutVideoInput,
    ruleConfig,
  });
  return {
    ...ruleConfig,
    pricingReadbackSha256: seedance25PricingReadbackDigest(document),
  };
}

/**
 * Generates an operator-owned route document but never persists it. Enabling
 * is impossible until the exact account model directory and an explicit
 * terminal-token reservation ceiling have both been attested.
 */
export function buildSeedance25LaunchRouteConfig(input: {
  featureFlagEnabled: boolean;
  videoExtensionEnabled?: boolean;
  videoEditEnabled?: boolean;
  accountModelCatalogEvidenceSha256?: string;
  providerAccountFingerprint?: string;
  accountModelCatalogVerifiedAt?: string;
  reservationUpperBoundTokens?: number;
}): Record<string, unknown> {
  if (input.featureFlagEnabled) {
    if (!/^[a-f0-9]{64}$/u.test(String(input.accountModelCatalogEvidenceSha256 || ""))) {
      throw new Seedance25AdapterError(
        "seedance25_account_catalog_unverified",
        "当前火山账号目录缺少可校验的 SHA-256 证据，不能启用路由",
        409,
      );
    }
    if (
      !/^[a-f0-9]{64}$/u.test(String(input.providerAccountFingerprint || ""))
      || !Number.isFinite(Date.parse(String(input.accountModelCatalogVerifiedAt || "")))
      || Date.parse(String(input.accountModelCatalogVerifiedAt || "")) > Date.now()
    ) {
      throw new Seedance25AdapterError(
        "seedance25_account_catalog_evidence_incomplete",
        "账号目录证据缺少账号指纹或验证时间",
        409,
      );
    }
    buildSeedance25TokenPricingRuleConfig({
      reservationUpperBoundTokens: Number(input.reservationUpperBoundTokens),
    });
  }
  const capability = verifiedSeedance25Capability(input.featureFlagEnabled, input.videoExtensionEnabled, input.videoEditEnabled);
  return {
    contractFamily: SEEDANCE_25_CONTRACT_FAMILY,
    capabilityStatus: "verified",
    label: "Seedance 2.5",
    resolutions: [...SEEDANCE_25_NATIVE_RESOLUTIONS],
    nativeResolutions: [...SEEDANCE_25_NATIVE_RESOLUTIONS],
    defaultResolution: "720p",
    aspectRatios: [...SEEDANCE_25_ASPECT_RATIOS],
    defaultAspectRatio: "16:9",
    duration: { min: 4, max: 30, step: 1, default: 5 },
    supportsGenerateAudio: true,
    modes: ["text_to_video", "omni_reference", ...(input.videoExtensionEnabled ? ["video_extension"] : []), ...(input.videoEditEnabled ? ["video_edit"] : [])],
    inputSlots: capability.inputSlots.map((slot) => ({
      id: slot.id,
      label: slot.label,
      roles: [...slot.roles],
      accepts: [slot.mediaType],
      min: slot.min,
      max: slot.max,
      modes: ["omni_reference", ...(input.videoExtensionEnabled ? ["video_extension"] : []), ...(input.videoEditEnabled ? ["video_edit"] : [])],
      allowDuplicateAsset: slot.allowDuplicateAsset,
      supportsTrim: slot.supportsTrim,
    })),
    accountModelCatalogEvidence: {
      version: "seedance-2.5-account-model-catalog-evidence/v1",
      model: SEEDANCE_25_MODEL_ID,
      sha256: String(input.accountModelCatalogEvidenceSha256 || ""),
      providerAccountFingerprint: String(input.providerAccountFingerprint || "").trim(),
      verifiedAt: String(input.accountModelCatalogVerifiedAt || ""),
    },
    videoGenerationContract: capability,
  };
}

/** Safe patch document for the existing overseas route; no DB write or activation. */
export function buildBytePlusSeedance25LaunchRouteConfig(input: {
  existingRouteConfig?: Record<string, unknown>;
  featureFlagEnabled: boolean;
  videoExtensionEnabled?: boolean;
  videoEditEnabled?: boolean;
  accountModelCatalogEvidenceSha256?: string;
  providerAccountFingerprint?: string;
  accountModelCatalogVerifiedAt?: string;
  draftEnabled?: boolean;
}): Record<string, unknown> {
  if (input.featureFlagEnabled && (
    !/^[a-f0-9]{64}$/u.test(String(input.accountModelCatalogEvidenceSha256 || ""))
    || !/^[a-f0-9]{64}$/u.test(String(input.providerAccountFingerprint || ""))
    || !Number.isFinite(Date.parse(String(input.accountModelCatalogVerifiedAt || "")))
    || Date.parse(String(input.accountModelCatalogVerifiedAt || "")) > Date.now()
  )) {
    fail("byteplus_seedance25_account_catalog_unverified", "海外账号模型目录证据不完整，不能启用正式路由", 409);
  }
  const extensionEnabled = input.videoExtensionEnabled ?? true;
  const editEnabled = input.videoEditEnabled ?? true;
  const capability = verifiedBytePlusSeedance25Capability(input.featureFlagEnabled, extensionEnabled, editEnabled);
  const slots = capability.inputSlots.map((slot) => ({
    id: slot.id, label: slot.label, accepts: [slot.mediaType], roles: [...slot.roles],
    min: slot.min, max: slot.max,
    modes: ["omni_reference", ...(slot.mediaType === "image" ? ["image_to_video", "first_last_frame"] : []),
      ...(extensionEnabled ? ["video_extension"] : []), ...(editEnabled ? ["video_edit"] : [])],
    allowDuplicateAsset: slot.allowDuplicateAsset, supportsTrim: slot.supportsTrim,
  }));
  return {
    ...input.existingRouteConfig,
    contractFamily: SEEDANCE_25_CONTRACT_FAMILY,
    capabilityStatus: "verified",
    label: "Seedance 2.5",
    description: "BytePlus Dreamina Seedance 2.5，支持文字、图像、视频、音频多参考与视频编辑延长",
    officialDocumentation: "https://docs.byteplus.com/en/docs/modelark/create-video-generation-task-api",
    resolutions: [...SEEDANCE_25_NATIVE_RESOLUTIONS],
    nativeResolutions: [...SEEDANCE_25_NATIVE_RESOLUTIONS],
    defaultResolution: "720p",
    aspectRatios: [...SEEDANCE_25_ASPECT_RATIOS, "adaptive"],
    defaultAspectRatio: "adaptive",
    duration: { min: 4, max: 30, step: 1, default: -1, auto: true },
    supportsGenerateAudio: true,
    modes: ["text_to_video", "image_to_video", "first_last_frame", "omni_reference", ...(extensionEnabled ? ["video_extension"] : []), ...(editEnabled ? ["video_edit"] : [])],
    inputSlots: slots,
    outputFormats: ["mp4", "mov"],
    defaultOutputFormat: "mp4",
    draftEnabled: input.draftEnabled === true,
    accountModelCatalogEvidence: {
      version: "seedance-2.5-account-model-catalog-evidence/v1",
      model: BYTEPLUS_SEEDANCE_25_MODEL_ID,
      sha256: String(input.accountModelCatalogEvidenceSha256 || ""),
      providerAccountFingerprint: String(input.providerAccountFingerprint || ""),
      verifiedAt: String(input.accountModelCatalogVerifiedAt || ""),
    },
    videoGenerationContract: capability,
  };
}

function assertOfficialDirectory(
  capability: WorkbenchModelCapability,
): {
  directory: WorkbenchVideoGenerationDirectory;
  pricingReadback: Seedance25AnyPricingReadbackBinding;
} {
  if (!isSeedance25ModelId(capability.id)) {
    fail("seedance25_model_id_mismatch", "Seedance 2.5 路由必须使用官方精确模型 ID");
  }
  const bytePlus = capability.id === BYTEPLUS_SEEDANCE_25_MODEL_ID;
  const directory = capability.videoGeneration;
  if (
    !directory
    || directory.contractFamily !== SEEDANCE_25_CONTRACT_FAMILY
    || directory.dispatchable !== true
    || directory.totalInputLimit !== SEEDANCE_25_V1_SAFE_INPUT_LIMITS.total
    || directory.mediaTypeLimits.image !== SEEDANCE_25_V1_SAFE_INPUT_LIMITS.image
    || directory.mediaTypeLimits.video !== SEEDANCE_25_V1_SAFE_INPUT_LIMITS.video
    || directory.mediaTypeLimits.audio !== SEEDANCE_25_V1_SAFE_INPUT_LIMITS.audio
    || directory.supportsGenerateAudio !== true
    || directory.supportsPreserveSourceAudio !== false
    || ![1, 2, 3].includes(directory.operations.length)
    || !directory.operations.some((operation) => operation.operation === "generate")
    || new Set(directory.operations.map((operation) => operation.operation)).size !== directory.operations.length
    || (bytePlus && (!exactStringSet(directory.outputFormats || [], ["mp4", "mov"])
      || directory.defaultOutputFormat !== "mp4"))
  ) {
    fail("seedance25_directory_mismatch", "模型目录与已验证的 Seedance 2.5 合同不一致", 409);
  }
  if (directory.operations.some((operation) => (
    !["generate", "extend", "edit"].includes(operation.operation)
    || operation.enabled !== true
    || operation.duration.min !== 4
    || operation.duration.max !== 30
    || operation.duration.step !== 1
    || (operation.operation === "edit" && operation.duration.auto !== true)
    || (bytePlus && operation.duration.auto !== true)
    || !exactStringSet(operation.nativeResolutions, SEEDANCE_25_NATIVE_RESOLUTIONS)
    || operation.fulfillmentResolutions.length !== 0
  ))) {
    fail("seedance25_operation_contract_mismatch", "Seedance 2.5 operation 合同不一致", 409);
  }
  const expectedSlots = new Map<string, { mediaType: string; max: number }>([
    ["reference_images", { mediaType: "image", max: 30 }],
    ["reference_videos", { mediaType: "video", max: 10 }],
    ["reference_audio", { mediaType: "audio", max: 10 }],
  ] as const);
  if (
    directory.inputSlots.length !== expectedSlots.size
    || directory.inputSlots.some((slot) => {
      const expected = expectedSlots.get(slot.id);
      return !expected
        || slot.mediaTypes.length !== 1
        || slot.mediaTypes[0] !== expected.mediaType
        || !exactStringSet(slot.roles, bytePlus && slot.mediaTypes[0] === "image"
          ? [...GENERIC_REFERENCE_ROLES, "first_frame", "last_frame"] : GENERIC_REFERENCE_ROLES)
        || !exactStringSet(slot.operations, directory.operations.map((operation) => operation.operation))
        || slot.min !== 0
        || slot.max !== expected.max
        || slot.allowDuplicateAsset
        || slot.supportsTrim;
    })
  ) {
    fail("seedance25_input_contract_mismatch", "Seedance 2.5 输入槽合同不一致", 409);
  }
  return {
    directory,
    pricingReadback: (bytePlus ? assertBytePlusSeedance25PricingBinding : assertSeedance25PricingBinding)(
      directory.formalPricingReadback,
    ),
  };
}

function policyDecisionsFromEvidence(input: {
  request: VideoGenerationRequest;
  evidence: TrustedVideoAssetPolicyEvidence;
  workspaceId: string;
  projectId: string;
}): VideoInputPolicyDecision[] {
  const requestedIds = [...new Set(input.request.inputs.map((item) => item.assetVersionId))].sort();
  const evidenceIds = [...input.evidence.assetVersionIds].sort();
  if (
    input.evidence.workspaceId !== input.workspaceId
    || input.evidence.projectId !== input.projectId
    || !exactStringSet(evidenceIds, requestedIds)
  ) {
    fail("seedance25_policy_scope_mismatch", "素材策略证据与 Seedance 2.5 请求范围不一致", 409);
  }
  return input.evidence.decisions.map((decision) => ({
    version: VIDEO_GENERATION_POLICY_VERSION,
    assetVersionId: decision.assetVersionId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    allowed: true,
    authorizationEvidenceId: decision.authorizationEvidenceId,
    moderationEvidenceId: decision.moderationEvidenceId,
    policyVersion: decision.policyVersion,
    ...(decision.consentExpiresAt ? { consentExpiresAt: decision.consentExpiresAt } : {}),
  }));
}

function assertProviderContentMatches(
  request: VideoGenerationRequest,
  providerContent: readonly Record<string, unknown>[],
): void {
  if (providerContent.length !== request.inputs.length) {
    fail("seedance25_provider_content_mismatch", "供应商素材映射与统一请求数量不一致", 409);
  }
  request.inputs.forEach((reference, index) => {
    const content = providerContent[index];
    const expectedType = `${reference.mediaType}_url`;
    const expectedRole = reference.role === "first_frame" || reference.role === "last_frame"
      ? reference.role : `reference_${reference.mediaType}`;
    if (
      content?.type !== expectedType
      || content?.role !== expectedRole
      || content?.reference_role !== reference.role
    ) {
      fail("seedance25_provider_content_mismatch", "供应商素材映射与统一请求顺序或角色不一致", 409);
    }
  });
}

export type PreparedSeedance25Request = {
  requestPayload: Record<string, unknown>;
  pricingTier: VideoInputPricingTier;
  relayAdapterBinding: {
    version: typeof SEEDANCE_25_RELAY_ADAPTER_BINDING_VERSION;
    contractFamily: typeof SEEDANCE_25_CONTRACT_FAMILY;
    adapterMappingVersion: typeof SEEDANCE_25_ADAPTER_MAPPING_VERSION | typeof BYTEPLUS_SEEDANCE_25_ADAPTER_MAPPING_VERSION;
    providerModel: Seedance25ModelId;
    pricingReadback: Seedance25AnyPricingReadbackBinding;
  };
};

export type PreparedSeedance25CertificationProbeRequest = {
  canonicalRequest: VideoGenerationRequest;
  canonicalDigest: string;
  requestPayload: Record<string, unknown>;
  requestId: string;
  scopedRequestId: string;
  principalId: string;
  relayAdapterBinding: PreparedSeedance25Request["relayAdapterBinding"];
};

/**
 * Exact durable Relay id for the fixed first-certification principal. Keep the
 * scoping algorithm here so task creation, dispatch revalidation and operator
 * evidence all compare one canonical value instead of reimplementing it.
 */
export function seedance25CertificationProbeScopedRequestId(input: {
  probeId: string;
  adminUserId: string;
}): string {
  if (
    typeof input.probeId !== "string"
    || !SEEDANCE_25_PROBE_UUID_V4_PATTERN.test(input.probeId)
    || parsePositiveDecimalId(input.adminUserId) === null
  ) {
    fail(
      "seedance25_certification_probe_identity_invalid",
      "Seedance 2.5 首次认证探针 scoped requestId 身份无效",
      409,
    );
  }
  const rawRequestId = `${SEEDANCE_25_CERTIFICATION_PROBE_REQUEST_ID_PREFIX}${input.probeId}`;
  const principalId = `seedance25-certification-admin:${input.adminUserId}`;
  const scopeDigest = crypto
    .createHash("sha256")
    .update(`video_generation:principal:${principalId}`)
    .digest("hex");
  return `${rawRequestId}:scope:${scopeDigest}`;
}

/**
 * Builds the only provider request allowed through the first-certification
 * seam. No model, payload, price, channel, request id or generation control is
 * accepted from the caller; all mutable facts come from the validated permit
 * and the exact persisted pricing readback.
 */
export function prepareSeedance25CertificationProbeRequest(input: {
  permit: Seedance25CertificationProbePermit;
  pricingReadback: Seedance25PricingReadbackBinding;
}): PreparedSeedance25CertificationProbeRequest {
  const permit = assertSeedance25CertificationProbePermit(input.permit);
  const pricingReadback = assertSeedance25PricingBinding(input.pricingReadback);
  const canonicalRequest = canonicalVideoGenerationRequest({
    version: VIDEO_GENERATION_REQUEST_VERSION,
    operation: "generate",
    modelRouteId: permit.routeId,
    prompt: SEEDANCE_25_CERTIFICATION_PROBE_PROMPT,
    aspectRatio: "16:9",
    durationSeconds: 4,
    outputResolution: "720p",
    generateAudio: false,
    preserveSourceAudio: false,
    inputs: [],
  });
  const requestId = `${SEEDANCE_25_CERTIFICATION_PROBE_REQUEST_ID_PREFIX}${permit.probeId}`;
  const principalId = `seedance25-certification-admin:${permit.adminUserId}`;
  return {
    canonicalRequest,
    canonicalDigest: videoGenerationRequestDigest(canonicalRequest),
    requestPayload: {
      model: SEEDANCE_25_MODEL_ID,
      content: [{ type: "text", text: SEEDANCE_25_CERTIFICATION_PROBE_PROMPT }],
      generate_audio: false,
      ratio: "16:9",
      duration: 4,
      resolution: "720p",
      watermark: false,
    },
    requestId,
    scopedRequestId: seedance25CertificationProbeScopedRequestId(permit),
    principalId,
    relayAdapterBinding: {
      version: SEEDANCE_25_RELAY_ADAPTER_BINDING_VERSION,
      contractFamily: SEEDANCE_25_CONTRACT_FAMILY,
      adapterMappingVersion: SEEDANCE_25_ADAPTER_MAPPING_VERSION,
      providerModel: SEEDANCE_25_MODEL_ID,
      pricingReadback,
    },
  };
}

/** Shared formal runtime preflight for Quick, Canvas, Agent and Public v3. */
export function prepareSeedance25Request(input: {
  capability: WorkbenchModelCapability;
  request: VideoGenerationRequest;
  providerContent: readonly Record<string, unknown>[];
  policyEvidence: TrustedVideoAssetPolicyEvidence;
  workspaceId: string;
  projectId: string;
}): PreparedSeedance25Request {
  const official = assertOfficialDirectory(input.capability);
  const bytePlus = input.capability.id === BYTEPLUS_SEEDANCE_25_MODEL_ID;
  const frameInputs = input.request.inputs.filter((reference) => reference.role === "first_frame" || reference.role === "last_frame");
  if (frameInputs.length) {
    const firstCount = frameInputs.filter((reference) => reference.role === "first_frame").length;
    const lastCount = frameInputs.filter((reference) => reference.role === "last_frame").length;
    if (!bytePlus || input.request.operation !== "generate" || firstCount !== 1 || lastCount > 1
      || frameInputs.length !== input.request.inputs.length
      || frameInputs.some((reference) => reference.mediaType !== "image")
      || input.request.aspectRatio !== "adaptive") {
      fail("seedance25_frame_contract_invalid", "首尾帧须仅使用图片：首帧 1 张、尾帧至多 1 张，画幅为 adaptive");
    }
  }
  if (input.request.outputFormat && (!bytePlus || !["mp4", "mov"].includes(input.request.outputFormat))) {
    fail("seedance25_output_format_unsupported", "所选 Seedance 2.5 模型不支持此输出格式");
  }
  if (input.request.renderMode === "finalize") fail("seedance25_final_requires_parent", "正式片必须通过样片任务入口提交");
  if (input.request.renderMode === "draft" && (input.capability.videoGeneration?.draft?.enabled !== true || input.request.outputResolution !== "480p")) {
    fail("seedance25_draft_resolution", "样片仅支持已开放的 Seedance 2.5 通道和 480p 输出");
  }
  const extending = input.request.operation === "extend";
  const editing = input.request.operation === "edit";
  const editEnabled = official.directory.operations.some((operation) => operation.operation === "edit" && operation.enabled);
  const extensionEnabled = official.directory.operations.some((operation) => operation.operation === "extend" && operation.enabled);
  if (!official.directory.operations.some((operation) => operation.operation === input.request.operation && operation.enabled)) {
    fail("seedance25_operation_disabled", "当前模型路由未开放此视频操作");
  }
  if (extending) {
    if (input.request.aspectRatio !== "adaptive") {
      fail("seedance25_extend_ratio_required", "视频延长的画幅必须跟随原片，请使用 adaptive");
    }
    if (!input.request.source?.assetVersionId || input.request.source.taskId || input.request.edit
      || !input.request.inputs.some((reference) => reference.mediaType === "video" && reference.assetVersionId === input.request.source?.assetVersionId)) {
      fail("seedance25_extend_source_required", "视频延长必须指定已提交的受控视频素材作为原片");
    }
  } else if (editing) {
    if (input.request.aspectRatio !== "adaptive" || input.request.durationSeconds !== -1) {
      fail("seedance25_edit_source_parameters_required", "视频编辑必须跟随原片画幅和时长，请使用 adaptive 和 duration=-1");
    }
    const videos = input.request.inputs.filter((reference) => reference.mediaType === "video");
    const sourceVideo = videos.find((video) => video.assetVersionId === input.request.source?.assetVersionId);
    if (!input.request.source?.assetVersionId || input.request.source.taskId
      || (!bytePlus && videos.length !== 1) || !sourceVideo || sourceVideo.trim) {
      fail("seedance25_edit_source_required", "视频编辑需要指定一段完整的受控原片（4–30 秒）");
    }
    // All edit instructions must reach the upstream text unchanged. Structured
    // mask/time-range edits are handled by the capability preflight below.
    if (!input.request.edit || input.request.edit.instruction !== input.request.prompt || input.request.edit.preserve.length) {
      fail("seedance25_edit_instruction_required", "请将完整修改与保留要求写入 prompt，并使用相同的 edit.instruction；不支持独立 preserve 字段");
    }
  } else if (!(SEEDANCE_25_ASPECT_RATIOS as readonly string[]).includes(input.request.aspectRatio)
    && !(bytePlus && input.request.aspectRatio === "adaptive")) {
    fail("seedance25_ratio_unsupported", "Seedance 2.5 输出比例不受官方合同支持");
  }
  if (!(SEEDANCE_25_NATIVE_RESOLUTIONS as readonly string[]).includes(input.request.outputResolution)) {
    fail("seedance25_resolution_unsupported", "Seedance 2.5 支持 480p、720p 或 1080p 原生输出");
  }
  if (input.request.preserveSourceAudio) {
    fail("seedance25_preserve_audio_unsupported", "Seedance 2.5 普通生成未开放保留来源音频开关");
  }
  assertProviderContentMatches(input.request, input.providerContent);
  // The canonical request retains the user's exact range for pricing/replay.
  // Only a signed server receipt allows the provider to consume a prepared file.
  const providerInputs = input.request.inputs.map((reference, index) => {
    if (!reference.trim) return reference;
    if (!hasPreparedReferenceTrim(reference, input.providerContent[index])) {
      fail("video_input_trim_unprepared", "参考素材时间段尚未处理完成，请重新提交");
    }
    if (reference.mediaType === "audio" && reference.trim.endMs - reference.trim.startMs < 1800) {
      fail("seedance25_reference_audio_too_short", "参考音频片段至少需要 1.8 秒，请延长所选时间段");
    }
    const { trim: _trim, ...prepared } = reference;
    return prepared;
  });
  const preflight = preflightVideoGeneration({
    capability: {
      ...(bytePlus ? verifiedBytePlusSeedance25Capability(true, extensionEnabled, editEnabled) : verifiedSeedance25Capability(true, extensionEnabled, editEnabled)),
      operations: (bytePlus ? verifiedBytePlusSeedance25Capability(true, extensionEnabled, editEnabled) : verifiedSeedance25Capability(true, extensionEnabled, editEnabled)).operations.map((operation) => ({
        ...operation,
        durationSeconds: {
          ...operation.durationSeconds,
          auto: bytePlus || operation.operation === "edit" || operation.operation === "generate" && input.capability.duration?.auto === true,
        },
      })),
    },
    request: { ...input.request, inputs: providerInputs },
    policyDecisions: policyDecisionsFromEvidence({
      request: input.request,
      evidence: input.policyEvidence,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
    }),
    workspaceId: input.workspaceId,
    projectId: input.projectId,
  });
  if (!preflight.ok) fail(preflight.code, preflight.message);

  const requestPayload = {
    model: input.capability.id,
    content: [
      ...(input.request.prompt ? [{ type: "text", text: input.request.prompt }] : []),
      ...input.providerContent,
    ],
    generate_audio: input.request.generateAudio,
    ratio: input.request.aspectRatio,
    duration: input.request.durationSeconds,
    ...(editing
      ? { omni_reference_task_type: "edit" }
      : extending
      ? { omni_reference_task_type: "extend" }
      : input.request.durationSeconds === -1 && input.request.inputs.length > 0
      ? { omni_reference_task_type: "reference" }
      : {}),
    resolution: input.request.outputResolution,
    ...(bytePlus && input.request.outputFormat ? { output_format: input.request.outputFormat } : {}),
    watermark: false,
    ...(input.request.renderMode === "draft" ? { draft: true } : {}),
  };
  return {
    requestPayload,
    pricingTier: videoInputPricingTierForRequestPayload(requestPayload),
    relayAdapterBinding: {
      version: SEEDANCE_25_RELAY_ADAPTER_BINDING_VERSION,
      contractFamily: SEEDANCE_25_CONTRACT_FAMILY,
      adapterMappingVersion: bytePlus ? BYTEPLUS_SEEDANCE_25_ADAPTER_MAPPING_VERSION : SEEDANCE_25_ADAPTER_MAPPING_VERSION,
      providerModel: input.capability.id as Seedance25ModelId,
      pricingReadback: official.pricingReadback,
    },
  };
}
