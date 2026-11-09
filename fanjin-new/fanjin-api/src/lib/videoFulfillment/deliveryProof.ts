import { types as nodeUtilTypes } from "node:util";
import type { Knex } from "knex";
import {
  readRelayFinalEvidenceDescriptor,
  readRelayMediaProbe,
} from "@/lib/videoFulfillment/deliveryConsumer";
import {
  normalizeVideoResolution,
  videoResolutionHeight,
} from "@/lib/videoResolutions";
import type { SafeMirroredVideo } from "@/lib/videoFulfillment/safeVideoMirror";

const INTERNAL_PROOF_VERSION = "relay-video-delivery-proof/v1" as const;
const PUBLIC_PROOF_VERSION = "public-video-delivery-proof/v1" as const;
const MAX_METADATA_BYTES = 64 * 1024;
const HIGH_RESOLUTION_OPERATIONS = new Set(["resolution:2k", "resolution:4k"]);

type PlainRecord = Record<string, unknown>;
type DatabaseRow = Record<string, any>;

export type VideoResolutionDelivery = "native" | "quality_enhancement";

export interface RelayVideoDeliveryProof {
  version: typeof INTERNAL_PROOF_VERSION;
  width: number;
  height: number;
  durationMs: number;
  videoCodec: string;
  bitrateBps: number;
  audioTrackCount: number;
  audioCodecs: string[];
  contentLengthBytes: number;
  downloadVerified: true;
  contentSha256: string;
}

/** Secret-free proof projection safe for Admin and release evidence. */
export interface PublicVideoDeliveryProof {
  version: typeof PUBLIC_PROOF_VERSION;
  operationKey: "resolution:2k" | "resolution:4k";
  resolution: "2k" | "4k";
  delivery: VideoResolutionDelivery;
  width: number;
  height: number;
  durationMs: number;
  videoCodec: string;
  bitrateBps: number;
  audioTrackCount: number;
  audioCodecs: string[];
  contentLengthBytes: number;
  downloadVerified: true;
  costMicros: number;
  currency: "GU";
}

export type VideoDeliveryProofEvaluation =
  | { ok: true; proof: PublicVideoDeliveryProof }
  | { ok: false; reason: string };

function isPlainRecord(value: unknown): value is PlainRecord {
  if (
    value == null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeUtilTypes.isProxy(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => "value" in descriptor && !descriptor.get && !descriptor.set,
  );
}

function parseRecord(value: unknown): PlainRecord | null {
  if (isPlainRecord(value)) return value;
  if (
    typeof value !== "string"
    || !value.trim()
    || Buffer.byteLength(value, "utf8") > MAX_METADATA_BYTES
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function ownValue(record: PlainRecord | null, key: string): unknown {
  if (!record) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor && !descriptor.get && !descriptor.set
    ? descriptor.value
    : undefined;
}

function ownRecord(record: PlainRecord | null, key: string): PlainRecord | null {
  return parseRecord(ownValue(record, key));
}

function positiveSafeInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function nonNegativeSafeInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function cleanCodec(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const codec = value.trim().toLowerCase();
  return codec && codec !== "unknown" && /^[a-z0-9._+-]{1,32}$/.test(codec)
    ? codec
    : null;
}

function cleanSha256(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
    ? value
    : null;
}

function cleanAudioCodecs(value: unknown, audioTrackCount: number): string[] | null {
  if (!Array.isArray(value) || value.length > 16) return null;
  const codecs: string[] = [];
  for (const item of value) {
    const codec = cleanCodec(item);
    if (!codec) return null;
    if (!codecs.includes(codec)) codecs.push(codec);
  }
  if (audioTrackCount > 0 && codecs.length === 0) return null;
  if (audioTrackCount === 0 && codecs.length > 0) return null;
  return codecs;
}

/** Build only from a file that the server downloaded, probed and hashed. */
export function createRelayVideoDeliveryProof(
  mirrored: SafeMirroredVideo,
): RelayVideoDeliveryProof | null {
  const width = positiveSafeInteger(mirrored.width);
  const height = positiveSafeInteger(mirrored.height);
  const durationMs = positiveSafeInteger(mirrored.durationMs);
  const videoCodec = cleanCodec(mirrored.videoCodec);
  const bitrateBps = positiveSafeInteger(mirrored.bitrateBps);
  const audioTrackCount = nonNegativeSafeInteger(mirrored.audioTrackCount);
  const contentLengthBytes = positiveSafeInteger(mirrored.contentLengthBytes);
  const contentSha256 = cleanSha256(mirrored.contentSha256);
  const audioCodecs = audioTrackCount === null
    ? null
    : cleanAudioCodecs(mirrored.audioCodecs, audioTrackCount);
  if (
    !width
    || !height
    || !durationMs
    || !videoCodec
    || !bitrateBps
    || audioTrackCount === null
    || !audioCodecs
    || !contentLengthBytes
    || !contentSha256
  ) {
    return null;
  }
  return {
    version: INTERNAL_PROOF_VERSION,
    width,
    height,
    durationMs,
    videoCodec,
    bitrateBps,
    audioTrackCount,
    audioCodecs,
    contentLengthBytes,
    downloadVerified: true,
    contentSha256,
  };
}

export function readRelayVideoDeliveryProof(value: unknown): RelayVideoDeliveryProof | null {
  if (!isPlainRecord(value)) return null;
  const expectedKeys = [
    "audioCodecs",
    "audioTrackCount",
    "bitrateBps",
    "contentLengthBytes",
    "contentSha256",
    "downloadVerified",
    "durationMs",
    "height",
    "version",
    "videoCodec",
    "width",
  ];
  const keys = Object.keys(value).sort();
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
  ) {
    return null;
  }
  const width = positiveSafeInteger(ownValue(value, "width"));
  const height = positiveSafeInteger(ownValue(value, "height"));
  const durationMs = positiveSafeInteger(ownValue(value, "durationMs"));
  const videoCodec = cleanCodec(ownValue(value, "videoCodec"));
  const bitrateBps = positiveSafeInteger(ownValue(value, "bitrateBps"));
  const audioTrackCount = nonNegativeSafeInteger(ownValue(value, "audioTrackCount"));
  const contentLengthBytes = positiveSafeInteger(ownValue(value, "contentLengthBytes"));
  const contentSha256 = cleanSha256(ownValue(value, "contentSha256"));
  const audioCodecs = audioTrackCount === null
    ? null
    : cleanAudioCodecs(ownValue(value, "audioCodecs"), audioTrackCount);
  if (
    ownValue(value, "version") !== INTERNAL_PROOF_VERSION
    || ownValue(value, "downloadVerified") !== true
    || !width
    || !height
    || !durationMs
    || !videoCodec
    || !bitrateBps
    || audioTrackCount === null
    || !audioCodecs
    || !contentLengthBytes
    || !contentSha256
  ) {
    return null;
  }
  return {
    version: INTERNAL_PROOF_VERSION,
    width,
    height,
    durationMs,
    videoCodec,
    bitrateBps,
    audioTrackCount,
    audioCodecs,
    contentLengthBytes,
    downloadVerified: true,
    contentSha256,
  };
}

function stringList(...values: unknown[]): string[] {
  const output: string[] = [];
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const normalized = normalizeVideoResolution(item);
      if (normalized && !output.includes(normalized)) output.push(normalized);
    }
  }
  return output;
}

/** Resolve the delivery claim encoded by the route without reading secrets. */
export function declaredVideoResolutionDelivery(
  routeConfigValue: unknown,
  resolutionValue: unknown,
): VideoResolutionDelivery {
  const resolution = normalizeVideoResolution(resolutionValue);
  const config = parseRecord(routeConfigValue) || {};
  const capabilities = ownRecord(config, "capabilities") || {};
  const operations = [ownValue(config, "operations"), ownValue(capabilities, "operations")]
    .filter(Array.isArray)
    .flat() as unknown[];
  const operationRecords = operations.filter(isPlainRecord);
  const nativeResolutions = stringList(
    ownValue(config, "nativeResolutions"),
    ownValue(capabilities, "nativeResolutions"),
    ...operationRecords.map((operation) => ownValue(operation, "nativeResolutions")),
  );
  const fulfillmentResolutions = stringList(
    ownValue(config, "fulfillmentResolutions"),
    ownValue(capabilities, "fulfillmentResolutions"),
    ...operationRecords.map((operation) => ownValue(operation, "fulfillmentResolutions")),
  );
  if (resolution && fulfillmentResolutions.includes(resolution)) {
    return "quality_enhancement";
  }
  if (resolution && nativeResolutions.includes(resolution)) return "native";
  const maxNative = normalizeVideoResolution(
    ownValue(config, "maxNativeResolution")
      ?? ownValue(capabilities, "maxNativeResolution"),
  );
  if (
    resolution
    && maxNative
    && videoResolutionHeight(resolution) <= videoResolutionHeight(maxNative)
  ) {
    return "native";
  }
  return "quality_enhancement";
}

function requestRequiresAudio(requestPayload: PlainRecord | null): boolean {
  const parameters = ownRecord(requestPayload, "parameters");
  return [
    ownValue(requestPayload, "generateAudio"),
    ownValue(requestPayload, "preserveSourceAudio"),
    ownValue(parameters, "generateAudio"),
    ownValue(parameters, "preserveSourceAudio"),
  ].some((value) => value === true);
}

function nullableProjectId(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  const number = positiveSafeInteger(value);
  return number ?? undefined;
}

/**
 * High-tier certification requires the exact durable final asset. Provider
 * declarations, a URL string or a successful task alone are not evidence.
 */
export async function evaluateVideoDeliveryProof(input: {
  database: Knex | Knex.Transaction;
  route: DatabaseRow;
  task: DatabaseRow;
  usage: DatabaseRow;
  operationKey: string;
}): Promise<VideoDeliveryProofEvaluation> {
  if (!HIGH_RESOLUTION_OPERATIONS.has(input.operationKey)) {
    return { ok: false, reason: "当前操作不是需要履约证明的 2K/4K 视频操作" };
  }
  const resolution = input.operationKey.slice("resolution:".length) as "2k" | "4k";
  const targetHeight = videoResolutionHeight(resolution);
  const requestPayload = parseRecord(input.task.requestPayload);
  const resultPayload = parseRecord(input.task.resultPayload);
  const internal = ownRecord(resultPayload, "internal");
  const finalEvidence = readRelayFinalEvidenceDescriptor(
    ownValue(internal, "deliveryFinalEvidence"),
  );
  if (!finalEvidence || finalEvidence.taskId !== String(input.task.id || "").trim()) {
    return { ok: false, reason: "2K/4K 任务缺少可验证的终态资产证据" };
  }
  if (normalizeVideoResolution(finalEvidence.resolution) !== resolution) {
    return { ok: false, reason: "终态资产证据与当前 2K/4K 档位不匹配" };
  }
  const delivery = declaredVideoResolutionDelivery(input.route.routeConfig, resolution);
  const expectedKind = delivery === "native" ? "generation_output" : "enhancement_output";
  if (finalEvidence.kind !== expectedKind) {
    return {
      ok: false,
      reason: delivery === "native"
        ? "路由声明原生直出，但真实任务未交付原生终态资产"
        : "路由声明履约超分，但真实任务未交付超分终态资产",
    };
  }

  const asset = await input.database("o_media_asset")
    .where({
      id: finalEvidence.assetId,
      taskId: String(input.task.id || "").trim(),
      source: "relay_final",
    })
    .first();
  const taskProjectId = nullableProjectId(input.task.projectId);
  const assetProjectId = nullableProjectId(asset?.projectId);
  if (
    !asset
    || String(asset.workspaceId || "") !== String(input.task.workspaceId || "")
    || taskProjectId === undefined
    || assetProjectId === undefined
    || taskProjectId !== assetProjectId
    || String(asset.assetType || "") !== "video"
    || !String(asset.url || "").trim()
    || !String(asset.mimeType || "").startsWith("video/")
  ) {
    return { ok: false, reason: "2K/4K 终态资产不属于当前任务或未持久化为可下载视频" };
  }
  const metadata = parseRecord(asset.metadata);
  const mediaProbe = readRelayMediaProbe(ownValue(metadata, "mediaProbe"));
  const proof = readRelayVideoDeliveryProof(ownValue(metadata, "deliveryProof"));
  if (!mediaProbe || !proof) {
    return { ok: false, reason: "2K/4K 终态资产缺少像素、码率、音轨或下载验证" };
  }
  if (
    Number(asset.width) !== proof.width
    || Number(asset.height) !== proof.height
    || Number(asset.durationMs) !== proof.durationMs
    || String(asset.mimeType || "") !== mediaProbe.mimeType
    || mediaProbe.width !== proof.width
    || mediaProbe.height !== proof.height
    || mediaProbe.durationMs !== proof.durationMs
    || mediaProbe.contentSha256 !== proof.contentSha256
  ) {
    return { ok: false, reason: "2K/4K 终态资产库字段与实测媒体证据不一致" };
  }
  if (Math.min(proof.width, proof.height) < targetHeight) {
    return { ok: false, reason: `${resolution.toUpperCase()} 终态视频实测短边像素未达标` };
  }
  if (requestRequiresAudio(requestPayload) && proof.audioTrackCount < 1) {
    return { ok: false, reason: "真实任务要求生成或保留音频，但终态视频未检测到音轨" };
  }
  const costMicros = positiveSafeInteger(input.usage.costMicros);
  if (!costMicros || String(input.usage.currency || "").toUpperCase() !== "GU") {
    return { ok: false, reason: "2K/4K 任务缺少正数 GU 实际成本" };
  }
  return {
    ok: true,
    proof: {
      version: PUBLIC_PROOF_VERSION,
      operationKey: input.operationKey as "resolution:2k" | "resolution:4k",
      resolution,
      delivery,
      width: proof.width,
      height: proof.height,
      durationMs: proof.durationMs,
      videoCodec: proof.videoCodec,
      bitrateBps: proof.bitrateBps,
      audioTrackCount: proof.audioTrackCount,
      audioCodecs: [...proof.audioCodecs],
      contentLengthBytes: proof.contentLengthBytes,
      downloadVerified: true,
      costMicros,
      currency: "GU",
    },
  };
}
