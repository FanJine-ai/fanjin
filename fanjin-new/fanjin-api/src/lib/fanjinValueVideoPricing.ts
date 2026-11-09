import type { Knex } from "knex";
import {
  FANJIN_VALUE_VIDEO_GENERATION_RESOLUTION,
  FANJIN_VALUE_VIDEO_MAX_DURATION_SECONDS,
  FANJIN_VALUE_VIDEO_MARKUP_BPS,
  FANJIN_VALUE_VIDEO_LEGACY_MARKUP_BPS,
  FANJIN_VALUE_VIDEO_TARGET_RESOLUTION,
  fanjinValueVideoOfferDefinition,
  fanjinValueVideoDuration,
  fanjinValueVideoResolutionPair,
  type FanjinValueGenerationResolution,
  type FanjinValueTargetResolution,
  type FanjinValueVideoMarkupBps,
} from "@/lib/fanjinValueVideoOffers";
import { PRICING_AUDIENCE_EFFECTIVE_KEY } from "@/lib/pricingAudience";
import { normalizeVideoResolution } from "@/lib/videoResolutions";
import { MEDIA_SERVICE_TABLE } from "@/lib/migrations/mediaServices";

export const FANJIN_VALUE_VIDEO_PRICING_VERSION =
  "fanjin-value-video-pricing/v1" as const;
export const FANJIN_VALUE_VIDEO_GENERATIVE_PRICING_VERSION =
  "fanjin-value-video-pricing/v2" as const;

export interface FanjinValueVideoPricingContract {
  version: typeof FANJIN_VALUE_VIDEO_PRICING_VERSION | typeof FANJIN_VALUE_VIDEO_GENERATIVE_PRICING_VERSION;
  upscaleMode?: "generative";
  publicModel: string;
  upstreamModel: string;
  generationResolution: FanjinValueGenerationResolution;
  targetResolution: FanjinValueTargetResolution;
  markupBps: FanjinValueVideoMarkupBps;
  maxDurationSeconds: number;
  upscalePricingRuleId: string;
  upscalePricingRuleUpdatedAt: number;
  upscaleUnitPriceMicros: number;
  generationCostEvidenceSha256: string;
  upscaleCostEvidenceSha256: string;
  successfulPipelineSmokeReceiptSha256: string;
}

export interface FanjinValueVideoPricingSnapshot extends FanjinValueVideoPricingContract {
  [key: string]: unknown;
  durationSeconds: number;
  generationReservationCostMicros: number;
  upscaleCostMicros: number;
  subtotalCostMicros: number;
  reservationCostMicros: number;
  audienceDiscountBps?: number;
}

const CONTRACT_KEYS = Object.freeze([
  "version",
  "publicModel",
  "upstreamModel",
  "generationResolution",
  "targetResolution",
  "markupBps",
  "maxDurationSeconds",
  "upscalePricingRuleId",
  "upscalePricingRuleUpdatedAt",
  "upscaleUnitPriceMicros",
  "generationCostEvidenceSha256",
  "upscaleCostEvidenceSha256",
  "successfulPipelineSmokeReceiptSha256",
] as const);

const SNAPSHOT_KEYS = Object.freeze([
  ...CONTRACT_KEYS,
  "durationSeconds",
  "generationReservationCostMicros",
  "upscaleCostMicros",
  "subtotalCostMicros",
  "reservationCostMicros",
] as const);
const AUDIENCE_DISCOUNT_SNAPSHOT_KEY = "audienceDiscountBps" as const;

export class FanjinValueVideoPricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FanjinValueVideoPricingError";
  }
}

function object(value: unknown): Record<string, unknown> | null {
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

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveSafeInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new FanjinValueVideoPricingError(`${label} 必须是正安全整数`);
  }
  return parsed;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new FanjinValueVideoPricingError(`${label} 必须是非负安全整数`);
  }
  return parsed;
}

function sha256(value: unknown, label: string): string {
  const normalized = text(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new FanjinValueVideoPricingError(`${label} 必须是小写 SHA-256`);
  }
  return normalized;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new FanjinValueVideoPricingError(`${label} 字段集合无效`);
  }
}

export function parseFanjinValueVideoPricingContract(input: {
  publicModel: unknown;
  ruleConfig: unknown;
  targetResolution?: unknown;
}): FanjinValueVideoPricingContract | null {
  const definition = fanjinValueVideoOfferDefinition(input.publicModel);
  if (!definition) return null;
  const config = object(input.ruleConfig);
  const requested = input.targetResolution == null ? "720p" : normalizeVideoResolution(input.targetResolution);
  if (!requested) throw new FanjinValueVideoPricingError("繁境特价版目标分辨率无效");
  const perResolution = object(config?.fanjinValueVideoPricingByResolution);
  const raw = object(perResolution ? perResolution[requested] : config?.fanjinValueVideoPricing);
  if (!raw) {
    throw new FanjinValueVideoPricingError("繁境特价版缺少组合定价契约");
  }
  const generative = raw.version === FANJIN_VALUE_VIDEO_GENERATIVE_PRICING_VERSION;
  exactKeys(raw, generative ? [...CONTRACT_KEYS, "upscaleMode"] : CONTRACT_KEYS, "fanjinValueVideoPricing");
  const pair = fanjinValueVideoResolutionPair(requested);
  const contract: FanjinValueVideoPricingContract = {
    version: raw.version as FanjinValueVideoPricingContract["version"],
    ...(generative ? { upscaleMode: raw.upscaleMode as "generative" } : {}),
    publicModel: text(raw.publicModel),
    upstreamModel: text(raw.upstreamModel),
    generationResolution: normalizeVideoResolution(
      raw.generationResolution,
    ) as FanjinValueGenerationResolution,
    targetResolution: normalizeVideoResolution(
      raw.targetResolution,
    ) as FanjinValueTargetResolution,
    markupBps: Number(raw.markupBps) as FanjinValueVideoMarkupBps,
    maxDurationSeconds: positiveSafeInteger(raw.maxDurationSeconds, "maxDurationSeconds"),
    upscalePricingRuleId: text(raw.upscalePricingRuleId),
    upscalePricingRuleUpdatedAt: nonNegativeSafeInteger(
      raw.upscalePricingRuleUpdatedAt,
      "upscalePricingRuleUpdatedAt",
    ),
    upscaleUnitPriceMicros: positiveSafeInteger(
      raw.upscaleUnitPriceMicros,
      "upscaleUnitPriceMicros",
    ),
    generationCostEvidenceSha256: sha256(
      raw.generationCostEvidenceSha256,
      "generationCostEvidenceSha256",
    ),
    upscaleCostEvidenceSha256: sha256(
      raw.upscaleCostEvidenceSha256,
      "upscaleCostEvidenceSha256",
    ),
    successfulPipelineSmokeReceiptSha256: sha256(
      raw.successfulPipelineSmokeReceiptSha256,
      "successfulPipelineSmokeReceiptSha256",
    ),
  };
  if (
    (contract.version !== FANJIN_VALUE_VIDEO_PRICING_VERSION && !generative)
    || (generative && contract.upscaleMode !== "generative")
    || contract.publicModel !== definition.publicModel
    || contract.upstreamModel !== definition.upstreamModel
    || !pair
    || contract.generationResolution !== pair.generationResolution
    || contract.targetResolution !== pair.targetResolution
    || !(contract.markupBps === FANJIN_VALUE_VIDEO_LEGACY_MARKUP_BPS
      || (generative && contract.markupBps === FANJIN_VALUE_VIDEO_MARKUP_BPS))
    || !contract.upscalePricingRuleId
    || !(contract.maxDurationSeconds === FANJIN_VALUE_VIDEO_MAX_DURATION_SECONDS
      || (generative && contract.maxDurationSeconds === fanjinValueVideoDuration(definition.publicModel).max))
  ) {
    throw new FanjinValueVideoPricingError("繁境特价版组合定价身份无效");
  }
  return Object.freeze(contract);
}

export function valueVideoDurationSeconds(requestPayload: unknown, publicModel: string): number {
  const payload = object(requestPayload);
  const duration = Number(payload?.duration ?? payload?.durationSeconds);
  const supported = fanjinValueVideoDuration(publicModel);
  if (
    !Number.isSafeInteger(duration)
    || duration < supported.min
    || duration > supported.max
  ) {
    throw new FanjinValueVideoPricingError(`繁境特价版必须绑定 ${supported.min}–${supported.max} 秒整数时长`);
  }
  return duration;
}

function ceilMarkup(subtotal: number, markupBps: number): number {
  if (!Number.isSafeInteger(subtotal) || subtotal <= 0) {
    throw new FanjinValueVideoPricingError("组合成本必须是正安全整数");
  }
  const numerator = BigInt(subtotal) * BigInt(10_000 + markupBps);
  const result = (numerator + 9_999n) / 10_000n;
  const number = Number(result);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new FanjinValueVideoPricingError("组合售价超出安全整数范围");
  }
  return number;
}

function discountedPositiveMicros(value: number, discountBps: number): number {
  if (discountBps === 10_000) return value;
  const result = (BigInt(value) * BigInt(discountBps) + 5_000n) / 10_000n;
  const normalized = Number(result < 1n ? 1n : result);
  if (!Number.isSafeInteger(normalized)) {
    throw new FanjinValueVideoPricingError("折后组合成本超出安全整数范围");
  }
  return normalized;
}

export function calculateFanjinValueVideoCompositeCost(input: {
  generationCostMicros: number;
  upscaleUnitPriceMicros: number;
  durationSeconds: number;
  markupBps?: number;
  audienceDiscountBps?: number;
}): {
  upscaleCostMicros: number;
  subtotalCostMicros: number;
  totalCostMicros: number;
} {
  const generationCostMicros = positiveSafeInteger(
    input.generationCostMicros,
    "generationCostMicros",
  );
  const upscaleUnitPriceMicros = positiveSafeInteger(
    input.upscaleUnitPriceMicros,
    "upscaleUnitPriceMicros",
  );
  const durationSeconds = positiveSafeInteger(input.durationSeconds, "durationSeconds");
  const markupBps = Number(input.markupBps ?? FANJIN_VALUE_VIDEO_MARKUP_BPS);
  if (markupBps !== FANJIN_VALUE_VIDEO_MARKUP_BPS && markupBps !== FANJIN_VALUE_VIDEO_LEGACY_MARKUP_BPS) {
    throw new FanjinValueVideoPricingError("繁境特价版价格策略无效");
  }
  const audienceDiscountBps = Number(input.audienceDiscountBps ?? 10_000);
  if (!Number.isSafeInteger(audienceDiscountBps) || audienceDiscountBps < 1 || audienceDiscountBps > 10_000) {
    throw new FanjinValueVideoPricingError("用户分组实付比例必须为 1-10000 基点");
  }
  const baseUpscaleCostMicros = upscaleUnitPriceMicros * durationSeconds;
  if (!Number.isSafeInteger(baseUpscaleCostMicros)) {
    throw new FanjinValueVideoPricingError("组合成本超出安全整数范围");
  }
  const upscaleCostMicros = audienceDiscountBps === 10_000
    ? baseUpscaleCostMicros
    : discountedPositiveMicros(baseUpscaleCostMicros, audienceDiscountBps);
  const subtotalCostMicros = generationCostMicros + upscaleCostMicros;
  if (!Number.isSafeInteger(upscaleCostMicros) || !Number.isSafeInteger(subtotalCostMicros)) {
    throw new FanjinValueVideoPricingError("组合成本超出安全整数范围");
  }
  return {
    upscaleCostMicros,
    subtotalCostMicros,
    totalCostMicros: ceilMarkup(subtotalCostMicros, markupBps),
  };
}

export function parseFanjinValueVideoPricingSnapshot(
  input: unknown,
): FanjinValueVideoPricingSnapshot {
  const raw = object(input);
  if (!raw) throw new FanjinValueVideoPricingError("组合价格快照无效");
  const hasAudienceDiscount = raw[AUDIENCE_DISCOUNT_SNAPSHOT_KEY] !== undefined;
  const contractKeys = raw.version === FANJIN_VALUE_VIDEO_GENERATIVE_PRICING_VERSION ? [...CONTRACT_KEYS, "upscaleMode"] : CONTRACT_KEYS;
  const snapshotKeys = raw.version === FANJIN_VALUE_VIDEO_GENERATIVE_PRICING_VERSION ? [...SNAPSHOT_KEYS, "upscaleMode"] : SNAPSHOT_KEYS;
  exactKeys(
    raw,
    hasAudienceDiscount ? [...snapshotKeys, AUDIENCE_DISCOUNT_SNAPSHOT_KEY] : snapshotKeys,
    "fanjinValueVideoPricingSnapshot",
  );
  const publicModel = text(raw.publicModel);
  const contract = parseFanjinValueVideoPricingContract({
    publicModel,
    targetResolution: raw.targetResolution,
    ruleConfig: {
      fanjinValueVideoPricing: Object.fromEntries(
        contractKeys.map((key) => [key, raw[key]]),
      ),
    },
  });
  if (!contract) throw new FanjinValueVideoPricingError("组合价格快照商品身份无效");
  const durationSeconds = valueVideoDurationSeconds(raw, publicModel);
  const generationReservationCostMicros = positiveSafeInteger(
    raw.generationReservationCostMicros,
    "generationReservationCostMicros",
  );
  const upscaleCostMicros = positiveSafeInteger(raw.upscaleCostMicros, "upscaleCostMicros");
  const subtotalCostMicros = positiveSafeInteger(raw.subtotalCostMicros, "subtotalCostMicros");
  const reservationCostMicros = positiveSafeInteger(
    raw.reservationCostMicros,
    "reservationCostMicros",
  );
  const audienceDiscountBps = hasAudienceDiscount
    ? positiveSafeInteger(raw[AUDIENCE_DISCOUNT_SNAPSHOT_KEY], AUDIENCE_DISCOUNT_SNAPSHOT_KEY)
    : 10_000;
  if (audienceDiscountBps > 10_000) {
    throw new FanjinValueVideoPricingError("用户分组实付比例不能超过 10000 基点");
  }
  if (durationSeconds > contract.maxDurationSeconds) {
    throw new FanjinValueVideoPricingError("组合价格快照时长超过证据上限");
  }
  const calculated = calculateFanjinValueVideoCompositeCost({
    generationCostMicros: generationReservationCostMicros,
    upscaleUnitPriceMicros: contract.upscaleUnitPriceMicros,
    durationSeconds,
    markupBps: contract.markupBps,
    audienceDiscountBps,
  });
  if (
    upscaleCostMicros !== calculated.upscaleCostMicros
    || subtotalCostMicros !== calculated.subtotalCostMicros
    || reservationCostMicros !== calculated.totalCostMicros
  ) {
    throw new FanjinValueVideoPricingError("组合价格快照分项或总价公式不一致");
  }
  return Object.freeze({
    ...contract,
    durationSeconds,
    generationReservationCostMicros,
    upscaleCostMicros,
    subtotalCostMicros,
    reservationCostMicros,
    ...(hasAudienceDiscount ? { audienceDiscountBps } : {}),
  });
}

function audienceDiscountBps(ruleConfig: unknown): number {
  const config = object(ruleConfig);
  const effective = object(config?.[PRICING_AUDIENCE_EFFECTIVE_KEY]);
  const discountBps = Number(effective?.discountBps ?? 10_000);
  return Number.isSafeInteger(discountBps) && discountBps >= 1 && discountBps <= 10_000
    ? discountBps
    : 10_000;
}

function pricingConfigPair(value: unknown): { source: string; target: string } {
  const config = object(value) ?? {};
  return {
    source: normalizeVideoResolution(config.sourceResolution) || "",
    target: normalizeVideoResolution(config.targetResolution) || "",
  };
}

export async function resolveFanjinValueVideoPricingSnapshot(input: {
  database: Knex | Knex.Transaction;
  workspaceId: string;
  publicModel: string;
  ruleConfig: unknown;
  requestPayload: unknown;
  generationReservationCostMicros: number;
}): Promise<FanjinValueVideoPricingSnapshot | null> {
  const contract = parseFanjinValueVideoPricingContract({
    publicModel: input.publicModel,
    ruleConfig: input.ruleConfig,
    targetResolution: object(input.requestPayload)?.resolution,
  });
  if (!contract) return null;
  // Existing v1 snapshots remain valid for settlement, but new schema-53 work
  // must carry fresh, explicitly generative cost and end-to-end evidence.
  if (await input.database.schema.hasTable(MEDIA_SERVICE_TABLE) && contract.upscaleMode !== "generative") {
    throw new FanjinValueVideoPricingError("大模型版需要 v2 组合定价与链路证据，不能复用旧版超分成本");
  }
  const durationSeconds = valueVideoDurationSeconds(input.requestPayload, input.publicModel);
  if (durationSeconds > contract.maxDurationSeconds) {
    throw new FanjinValueVideoPricingError("请求时长超过组合定价证据上限");
  }
  const row = await input.database("o_pricing_rule")
    .where({ id: contract.upscalePricingRuleId, endpointType: "video_enhance", disabled: 0 })
    .first();
  const pair = pricingConfigPair(row?.ruleConfig);
  const scope = text(row?.scope);
  const scopeValid = scope === "platform"
    ? row?.workspaceId == null
    : scope === "workspace" && text(row?.workspaceId) === input.workspaceId;
  if (
    !row
    || !scopeValid
    || text(row.provider)
    || text(row.model)
    || text(row.unit) !== "second"
    || text(row.currency).toUpperCase() !== "GU"
    || Number(row.updateTime) !== contract.upscalePricingRuleUpdatedAt
    || Number(row.unitPriceMicros) !== contract.upscaleUnitPriceMicros
    || pair.source !== contract.generationResolution
    || pair.target !== contract.targetResolution
  ) {
    throw new FanjinValueVideoPricingError("超分价格行与组合定价证据不一致");
  }
  const effectiveAudienceDiscountBps = audienceDiscountBps(input.ruleConfig);
  const cost = calculateFanjinValueVideoCompositeCost({
    generationCostMicros: input.generationReservationCostMicros,
    upscaleUnitPriceMicros: contract.upscaleUnitPriceMicros,
    durationSeconds,
    markupBps: contract.markupBps,
    audienceDiscountBps: effectiveAudienceDiscountBps,
  });
  return Object.freeze({
    ...contract,
    durationSeconds,
    generationReservationCostMicros: input.generationReservationCostMicros,
    upscaleCostMicros: cost.upscaleCostMicros,
    subtotalCostMicros: cost.subtotalCostMicros,
    reservationCostMicros: cost.totalCostMicros,
    ...(effectiveAudienceDiscountBps !== 10_000
      ? { audienceDiscountBps: effectiveAudienceDiscountBps }
      : {}),
  });
}

export function calculateFanjinValueVideoActualCost(input: {
  snapshot: unknown;
  actualGenerationCostMicros: number;
}): number {
  const snapshot = parseFanjinValueVideoPricingSnapshot(input.snapshot);
  const result = calculateFanjinValueVideoCompositeCost({
    generationCostMicros: input.actualGenerationCostMicros,
    upscaleUnitPriceMicros: snapshot.upscaleUnitPriceMicros,
    durationSeconds: snapshot.durationSeconds,
    markupBps: snapshot.markupBps,
    audienceDiscountBps: snapshot.audienceDiscountBps,
  });
  const reserved = snapshot.reservationCostMicros;
  if (result.totalCostMicros > reserved) {
    throw new FanjinValueVideoPricingError("组合实际费用超过冻结上限");
  }
  return result.totalCostMicros;
}
