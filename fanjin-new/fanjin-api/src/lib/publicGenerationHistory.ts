import { publicCreationLineageDigest } from "@/lib/publicCreationObservability";

export const PUBLIC_GENERATION_HISTORY_VERSION = 1 as const;

export const PUBLIC_GENERATION_OPERATIONS = [
  "generate",
  "extend",
  "edit",
  "upscale",
] as const;

export type PublicGenerationOperation = (typeof PUBLIC_GENERATION_OPERATIONS)[number];
export type PublicGenerationBillingState =
  | "captured"
  | "free"
  | "pending"
  | "released"
  | "unavailable";

type PublicGenerationParameter = string | number | boolean;

export type PublicGenerationHistory = {
  version: typeof PUBLIC_GENERATION_HISTORY_VERSION;
  operation: PublicGenerationOperation;
  derivedFromSource: boolean;
  parentVersionDigest?: string;
  parameters: Record<string, PublicGenerationParameter>;
  billing: {
    state: PublicGenerationBillingState;
    currency: "GU";
    costMicros: number | null;
  };
};

const PUBLIC_RESOLUTIONS = new Set(["480p", "720p", "1080p", "2160p", "2k", "4k"]);
const PUBLIC_IMAGE_QUALITIES = new Set(["1K", "2K", "4K"]);
const PUBLIC_ASPECT_RATIOS = new Set([
  "1:1",
  "3:4",
  "4:3",
  "9:16",
  "16:9",
  "21:9",
]);
const PUBLIC_OPERATIONS = new Set<string>(PUBLIC_GENERATION_OPERATIONS);

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 256 * 1024) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function resolution(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim().toLowerCase();
  return PUBLIC_RESOLUTIONS.has(clean) ? clean : undefined;
}

function quality(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim().toUpperCase();
  return PUBLIC_IMAGE_QUALITIES.has(clean) ? clean : undefined;
}

function aspectRatio(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  return PUBLIC_ASPECT_RATIOS.has(clean) ? clean : undefined;
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number | undefined {
  const clean = Number(value);
  return Number.isFinite(clean) && clean >= minimum && clean <= maximum
    ? clean
    : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function canonicalRequest(resultPayloadValue: unknown): Record<string, unknown> {
  const result = record(resultPayloadValue);
  const internal = record(result.internal);
  const binding = record(internal.canonicalVideoGeneration);
  return record(binding.request);
}

function operationFor(input: {
  assetSource?: unknown;
  resultPayload?: unknown;
}): PublicGenerationOperation {
  if (String(input.assetSource || "").trim() === "video_enhance") return "upscale";
  const operation = String(canonicalRequest(input.resultPayload).operation || "").trim();
  return PUBLIC_OPERATIONS.has(operation)
    ? operation as PublicGenerationOperation
    : "generate";
}

function publicParameters(input: {
  assetSource?: unknown;
  assetMetadata?: unknown;
  requestPayload?: unknown;
  resultPayload?: unknown;
}): Record<string, PublicGenerationParameter> {
  const metadata = record(input.assetMetadata);
  const request = record(input.requestPayload);
  const canonical = canonicalRequest(input.resultPayload);
  const output: Record<string, PublicGenerationParameter> = {};

  const sourceResolution = resolution(metadata.sourceResolution);
  const targetResolution = resolution(
    metadata.targetResolution
      ?? metadata.finalResolution
      ?? canonical.outputResolution
      ?? request.resolution,
  );
  const outputResolution = resolution(
    canonical.outputResolution
      ?? request.resolution
      ?? metadata.finalResolution
      ?? metadata.targetResolution
      ?? metadata.requestedResolution
      ?? metadata.resolution,
  );
  const imageQuality = quality(metadata.quality ?? request.quality ?? request.size);
  const ratio = aspectRatio(canonical.aspectRatio ?? request.ratio ?? request.aspectRatio);
  const durationSeconds = boundedNumber(
    canonical.durationSeconds
      ?? request.duration
      ?? request.durationSeconds
      ?? metadata.durationSeconds,
    0,
    24 * 60 * 60,
  );
  const audio = booleanValue(
    canonical.generateAudio
      ?? request.generate_audio
      ?? request.generateAudio
      ?? request.audio,
  );

  if (sourceResolution) output.sourceResolution = sourceResolution;
  if (targetResolution) output.targetResolution = targetResolution;
  if (outputResolution) output.outputResolution = outputResolution;
  if (imageQuality) output.quality = imageQuality;
  if (ratio) output.aspectRatio = ratio;
  if (durationSeconds !== undefined) output.durationSeconds = durationSeconds;
  if (audio !== undefined) output.audio = audio;
  return output;
}

function lineageReference(input: {
  assetSource?: unknown;
  assetMetadata?: unknown;
  resultPayload?: unknown;
}): { kind: "asset" | "asset_version" | "task"; id: unknown } | null {
  const metadata = record(input.assetMetadata);
  const canonical = canonicalRequest(input.resultPayload);
  const source = record(canonical.source);
  const operation = operationFor(input);
  if (operation === "generate") return null;
  if (metadata.sourceAssetId != null && String(metadata.sourceAssetId).trim()) {
    return { kind: "asset", id: metadata.sourceAssetId };
  }
  if (source.assetVersionId != null && String(source.assetVersionId).trim()) {
    return { kind: "asset_version", id: source.assetVersionId };
  }
  if (source.taskId != null && String(source.taskId).trim()) {
    return { kind: "task", id: source.taskId };
  }
  return null;
}

function publicBilling(value: unknown): PublicGenerationHistory["billing"] {
  const usage = record(value);
  const status = String(usage.status || "").trim().toLowerCase();
  const currency = String(usage.currency || "GU").trim().toUpperCase();
  const cost = Number(usage.costMicros);
  const safeCost = currency === "GU" && Number.isSafeInteger(cost) && cost >= 0
    ? cost
    : null;
  if (status === "charged") {
    return { state: "captured", currency: "GU", costMicros: safeCost };
  }
  if (status === "free") {
    return { state: "free", currency: "GU", costMicros: 0 };
  }
  if (["reserved", "pending_reconcile"].includes(status)) {
    return { state: "pending", currency: "GU", costMicros: null };
  }
  if (["released", "refunded"].includes(status)) {
    return { state: "released", currency: "GU", costMicros: 0 };
  }
  return { state: "unavailable", currency: "GU", costMicros: null };
}

export function buildPublicGenerationHistory(input: {
  tokenKey: string;
  workspaceId: unknown;
  projectId: unknown;
  assetSource?: unknown;
  assetMetadata?: unknown;
  requestPayload?: unknown;
  resultPayload?: unknown;
  usage?: unknown;
}): PublicGenerationHistory {
  const operation = operationFor(input);
  const parent = lineageReference(input);
  return {
    version: PUBLIC_GENERATION_HISTORY_VERSION,
    operation,
    derivedFromSource: Boolean(parent),
    ...(parent
      ? {
          parentVersionDigest: publicCreationLineageDigest({
            tokenKey: input.tokenKey,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            referenceKind: parent.kind,
            referenceId: parent.id,
          }),
        }
      : {}),
    parameters: publicParameters(input),
    billing: publicBilling(input.usage),
  };
}
