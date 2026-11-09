import { parseFanjinValueVideoPricingContract } from "@/lib/fanjinValueVideoPricing";
import type { VideoReferenceDurations } from "./videoReferenceDuration";
import { BYTEPLUS_SEEDANCE_25_MODEL_ID } from "./seedance25ModelIds";

const SEEDANCE_25 = "doubao-seedance-2-5-260628";
const SEEDANCE_25_VALUE = "fanjin-seedance-2-5-value-720p";
const SEEDANCE_20_FAST = "doubao-seedance-2-0-fast-260128";

// Official 16:9 examples and pixel-area formula, verified 2026-09-22:
// https://docs.volcengine.com/docs/ark/model-pricing?lang=zh
// 480p: 5s = 48,000 tokens; 720p: 108,000; 1080p: ~243,000.
// The provider selects the exact dimensions. Reserve 10% for dimension/frame
// rounding, then settle authoritative completion_tokens and release the rest.
const TOKENS_PER_SECOND: Record<string, number> = {
  "480p": 9_600,
  "720p": 21_600,
  "1080p": 48_600,
};

export interface VideoTokenReservation {
  version: "seedance25-request-reservation/v1";
  configuredUpperBoundTokens: number;
  reservationTokens: number;
  estimatedTokens: number | null;
  generationResolution: string | null;
  durationSeconds: number | null;
  marginBps: number;
  basis: "request_estimate" | "configured_limit";
  fallbackReason?: string;
  referenceDurationSeconds?: number;
  referenceDurationDigest?: string;
  durationBasis?: "fixed" | "source_video" | "auto_upper_bound";
  inputVideoReserveFloorMultiplier?: number;
}

/** A model-wide safety limit is not a quote for a specific short clip. Keep
 * legacy snapshots readable, but never offer that fallback as a new scoped
 * Canvas/MCP estimate or reserve it after a failed duration probe. */
export class VideoPricingEstimateError extends Error {
  readonly code: string;
  readonly status: number;
  readonly statusCode: number;
  constructor(unavailable: boolean) {
    super(unavailable
      ? "暂时无法核算参考视频时长，请重试报价。素材已保存，本次未冻结或扣费。"
      : "当前视频参数无法得到有效费用估算，请检查时长、分辨率或价格配置后重新报价。本次未冻结或扣费。");
    this.name = "VideoPricingEstimateError";
    this.code = unavailable ? "video_pricing_evidence_unavailable" : "video_pricing_estimate_unavailable";
    this.status = this.statusCode = unavailable ? 503 : 422;
  }
}

export function assertRequestVideoTokenEstimate(reservation: VideoTokenReservation | null): void {
  if (!reservation || reservation.basis === "request_estimate"
    || ["model_not_supported", "configured_limit_below_estimate"].includes(reservation.fallbackReason || "")) return;
  throw new VideoPricingEstimateError(reservation.fallbackReason === "reference_video_duration_unavailable");
}

/** Server-owned policy, shared by quotes and the actual wallet reservation. */
export function resolveVideoTokenReservation(input: {
  model: string;
  ruleConfig: unknown;
  requestPayload: Record<string, unknown>;
  configuredUpperBoundTokens: number;
  /** Server storage probe only; never populate from request JSON. */
  referenceDurations?: VideoReferenceDurations;
}): VideoTokenReservation {
  const limit = input.configuredUpperBoundTokens;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("视频预扣上限必须为正安全整数");
  const fallback = (fallbackReason: string): VideoTokenReservation => ({
    version: "seedance25-request-reservation/v1",
    configuredUpperBoundTokens: limit,
    reservationTokens: limit,
    estimatedTokens: null,
    generationResolution: null,
    durationSeconds: null,
    marginBps: 0,
    basis: "configured_limit",
    fallbackReason,
  });
  if (![SEEDANCE_25, SEEDANCE_25_VALUE, BYTEPLUS_SEEDANCE_25_MODEL_ID, SEEDANCE_20_FAST].includes(input.model)) return fallback("model_not_supported");
  const isFast = input.model === SEEDANCE_20_FAST;
  const maximumDuration = isFast ? 15 : 30;
  const payload = input.requestPayload;
  const references = Array.isArray(payload.content) ? payload.content.filter(item => item?.type === "video_url") : [];
  const measured = input.referenceDurations;
  const validMeasurement = measured && measured.count === references.length && measured.count > 0
    && Number.isFinite(measured.totalSeconds) && measured.totalSeconds >= 2 && measured.totalSeconds <= 30.05
    && /^[a-f0-9]{64}$/.test(measured.digest);
  let duration = Number(payload.duration);
  const followsSource = duration === -1 && validMeasurement && measured.operation === "edit"
    && measured.sourceSeconds != null && measured.sourceSeconds >= 4 && measured.sourceSeconds <= 30.05;
  const autoUpperBound = input.model !== SEEDANCE_25_VALUE
    && duration === -1 && !followsSource && measured?.operation !== "edit" && payload.omni_reference_task_type !== "edit";
  if (references.length && !validMeasurement) return fallback("reference_video_duration_unavailable");
  if (followsSource) duration = measured.sourceSeconds!;
  if (autoUpperBound) duration = maximumDuration;
  if ((!followsSource && !Number.isSafeInteger(duration)) || duration < 4 || duration > maximumDuration + 0.05) return fallback("fixed_duration_required");
  const contract = input.model === SEEDANCE_25_VALUE
    ? parseFanjinValueVideoPricingContract({ publicModel: input.model, ruleConfig: input.ruleConfig, targetResolution: payload.resolution })
    : null;
  const resolution = contract?.generationResolution ?? String(payload.resolution ?? "720p").toLowerCase();
  const rate = TOKENS_PER_SECOND[resolution];
  if (isFast && !["480p", "720p"].includes(resolution)) return fallback("resolution_not_supported");
  if (!rate) return fallback("resolution_not_supported");
  // Ark estimates tokens from (input + output) duration × output pixel area.
  // Video inputs also have a billing floor. Our reservation conservatively
  // covers at least 2× output duration, plus the existing 10% rounding buffer;
  // this is a wallet reserve policy, NOT an asserted provider charge/minimum.
  // Actual completion_tokens alone determines settlement.
  const billableSeconds = references.length ? Math.max(duration + measured!.totalSeconds, 2 * duration) : duration;
  const estimatedTokens = Math.ceil(rate * billableSeconds);
  const reservationTokens = Math.ceil(estimatedTokens * 11 / 10);
  // Never silently widen an operator's certified limit.
  if (reservationTokens > limit) return fallback("configured_limit_below_estimate");
  return {
    version: "seedance25-request-reservation/v1",
    configuredUpperBoundTokens: limit,
    reservationTokens,
    estimatedTokens,
    generationResolution: resolution,
    durationSeconds: duration,
    marginBps: 1_000,
    basis: "request_estimate",
    ...(references.length ? { referenceDurationSeconds: measured!.totalSeconds, referenceDurationDigest: measured!.digest,
      inputVideoReserveFloorMultiplier: 2 } : {}),
    durationBasis: followsSource ? "source_video" : autoUpperBound ? "auto_upper_bound" : "fixed",
  };
}
