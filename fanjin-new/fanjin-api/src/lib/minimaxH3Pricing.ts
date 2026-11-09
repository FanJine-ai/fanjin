import { isMiniMaxH3Model, type MiniMaxH3ModelId } from "@/lib/minimaxH3Manifest";

export const MINIMAX_H3_PRICING_VERSION = "minimax-h3-output-second/v1";

type PricingRates = {
  outputMicrosPerSecond: Record<string, number>;
  inputVideoMicrosPerSecond: Record<string, number>;
  extraImageMicros: number;
  freeImageCount: number;
  maximumInputVideoSeconds: number;
};

export interface MiniMaxH3PricingSnapshot extends PricingRates {
  version: typeof MINIMAX_H3_PRICING_VERSION;
  model: MiniMaxH3ModelId;
  resolution: string;
  requestedOutputSeconds: number;
  requestedImageCount: number;
  requestedVideoCount: number;
  reservedInputVideoSeconds: number;
  reservationCostMicros: number;
}

export class MiniMaxH3PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MiniMaxH3PricingError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
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

function positiveSafeInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new MiniMaxH3PricingError(`${label} 必须是正安全整数`);
  }
  return parsed;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new MiniMaxH3PricingError(`${label} 必须是非负安全整数`);
  }
  return parsed;
}

function normalizeResolution(value: unknown): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "768p" || normalized === "2k" || normalized === "480p") return normalized;
  throw new MiniMaxH3PricingError("MiniMax H3 计费分辨率无效");
}

function parseRates(ruleConfig: unknown, model: MiniMaxH3ModelId): PricingRates {
  const config = record(ruleConfig);
  const contract = record(config?.minimaxH3Pricing);
  if (contract?.version !== MINIMAX_H3_PRICING_VERSION) {
    throw new MiniMaxH3PricingError("MiniMax H3 定价合同版本无效");
  }
  const output = record(contract.outputMicrosPerSecond) ?? {};
  const inputVideo = record(contract.inputVideoMicrosPerSecond) ?? {};
  const supported = model === "MiniMax-H3" ? ["768p", "2k"] : ["480p", "768p"];
  const outputMicrosPerSecond: Record<string, number> = {};
  const inputVideoMicrosPerSecond: Record<string, number> = {};
  for (const resolution of supported) {
    outputMicrosPerSecond[resolution] = positiveSafeInteger(
      output[resolution],
      `outputMicrosPerSecond.${resolution}`,
    );
    inputVideoMicrosPerSecond[resolution] = model === "MiniMax-H3"
      ? positiveSafeInteger(inputVideo[resolution], `inputVideoMicrosPerSecond.${resolution}`)
      : outputMicrosPerSecond[resolution];
  }
  return {
    outputMicrosPerSecond,
    inputVideoMicrosPerSecond,
    extraImageMicros: model === "MiniMax-H3"
      ? positiveSafeInteger(contract.extraImageMicros, "extraImageMicros")
      : 0,
    freeImageCount: model === "MiniMax-H3"
      ? nonNegativeSafeInteger(contract.freeImageCount, "freeImageCount")
      : 0,
    maximumInputVideoSeconds: model === "MiniMax-H3"
      ? positiveSafeInteger(contract.maximumInputVideoSeconds, "maximumInputVideoSeconds")
      : 0,
  };
}

function contentCounts(payload: Record<string, unknown>): { images: number; videos: number } {
  const content = Array.isArray(payload.content) ? payload.content : [];
  let images = 0;
  let videos = 0;
  for (const value of content) {
    const item = record(value);
    if (item?.type === "image_url") images += 1;
    if (item?.type === "video_url") videos += 1;
  }
  return { images, videos };
}

function safeCost(parts: number[]): number {
  const cost = parts.reduce((total, part) => total + part, 0);
  if (!Number.isSafeInteger(cost) || cost <= 0) {
    throw new MiniMaxH3PricingError("MiniMax H3 价格超出安全整数范围");
  }
  return cost;
}

export function resolveMiniMaxH3ReservationPricing(input: {
  model: unknown;
  requestPayload: unknown;
  ruleConfig: unknown;
}): { unitPriceMicros: number; snapshot: MiniMaxH3PricingSnapshot } {
  if (!isMiniMaxH3Model(input.model)) {
    throw new MiniMaxH3PricingError("MiniMax H3 定价模型无效");
  }
  const payload = record(input.requestPayload) ?? {};
  const resolution = normalizeResolution(payload.resolution);
  const duration = positiveSafeInteger(payload.duration, "duration");
  const minimumDuration = input.model === "MiniMax-H3" ? 4 : 5;
  if (duration < minimumDuration || duration > 15) {
    throw new MiniMaxH3PricingError(`当前 MiniMax H3 模型仅支持 ${minimumDuration}-15 秒`);
  }
  const rates = parseRates(input.ruleConfig, input.model);
  const outputRate = rates.outputMicrosPerSecond[resolution];
  if (!outputRate) throw new MiniMaxH3PricingError("当前分辨率没有 MiniMax H3 输出定价");
  const counts = contentCounts(payload);
  if (input.model === "MiniMax-H3-Max" && (counts.images > 2 || counts.videos > 0)) {
    throw new MiniMaxH3PricingError("MiniMax H3 Max 输入素材超出官方能力");
  }
  const reservedInputVideoSeconds = counts.videos > 0 ? rates.maximumInputVideoSeconds : 0;
  const extraImages = Math.max(0, counts.images - rates.freeImageCount);
  const reservationCostMicros = safeCost([
    outputRate * duration,
    (rates.inputVideoMicrosPerSecond[resolution] || 0) * reservedInputVideoSeconds,
    rates.extraImageMicros * extraImages,
  ]);
  return {
    unitPriceMicros: reservationCostMicros,
    snapshot: {
      version: MINIMAX_H3_PRICING_VERSION,
      model: input.model,
      resolution,
      requestedOutputSeconds: duration,
      requestedImageCount: counts.images,
      requestedVideoCount: counts.videos,
      reservedInputVideoSeconds,
      reservationCostMicros,
      ...rates,
    },
  };
}

export function calculateMiniMaxH3TerminalCost(input: {
  snapshot: unknown;
  providerPayload: unknown;
}): { costMicros: number; outputSeconds: number; inputVideoSeconds: number; inputImageCount: number } {
  const snapshot = record(input.snapshot) as unknown as MiniMaxH3PricingSnapshot | null;
  if (!snapshot || snapshot.version !== MINIMAX_H3_PRICING_VERSION || !isMiniMaxH3Model(snapshot.model)) {
    throw new MiniMaxH3PricingError("MiniMax H3 终态价格快照无效");
  }
  const task = record(record(input.providerPayload)?.task);
  const usage = record(task?.usage);
  const outputSeconds = positiveSafeInteger(usage?.output_seconds, "usage.output_seconds");
  const inputVideoSeconds = nonNegativeSafeInteger(usage?.input_seconds ?? 0, "usage.input_seconds");
  const inputImageCount = nonNegativeSafeInteger(usage?.input_image_count ?? 0, "usage.input_image_count");
  if (
    outputSeconds > snapshot.requestedOutputSeconds
    || inputVideoSeconds > snapshot.reservedInputVideoSeconds
    || inputImageCount > snapshot.requestedImageCount
  ) {
    throw new MiniMaxH3PricingError("MiniMax H3 终态 usage 超过预留上限");
  }
  const outputRate = snapshot.outputMicrosPerSecond[snapshot.resolution];
  const inputRate = snapshot.inputVideoMicrosPerSecond[snapshot.resolution] || 0;
  const extraImages = Math.max(0, inputImageCount - snapshot.freeImageCount);
  const costMicros = safeCost([
    outputRate * outputSeconds,
    inputRate * inputVideoSeconds,
    snapshot.extraImageMicros * extraImages,
  ]);
  if (costMicros > snapshot.reservationCostMicros) {
    throw new MiniMaxH3PricingError("MiniMax H3 终态费用超过预留金额");
  }
  return { costMicros, outputSeconds, inputVideoSeconds, inputImageCount };
}
