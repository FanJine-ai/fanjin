import { GU_MICROS_PER_GU } from "@/utils/billingUnits";
export type ModelRouteTier = "P0" | "P1" | "P2";
export type ModelPublicationStatus = "draft" | "needs_attention" | "ready" | "published" | "degraded" | "unavailable";

export interface ModelPoolItem {
  poolId: string;
  scope: "platform" | "workspace";
  workspaceId: string | null;
  endpointType: string;
  channelId: string;
  channelName: string;
  provider: string;
  upstreamModel: string;
  health: "healthy" | "degraded" | "unhealthy" | "unknown";
  disabled: boolean;
  routedGroupKeys: string[];
  capabilityFingerprint: string;
}

export interface ModelRouteGroupTarget {
  id: string;
  name: string;
  provider: string;
  channelId: string;
  channelName: string;
  upstreamModel: string;
  tier: ModelRouteTier;
  priority: number;
  trafficWeight: number;
  effectiveWeightSource: "route" | "channel" | "default";
  normalizedTrafficPercent: number;
  disabled: boolean;
  health: ModelPoolItem["health"];
  capabilityFingerprint: string;
  routeConfig: Record<string, unknown>;
}

export interface LogicalModelPrice {
  id: string;
  name: string;
  unit: string;
  unitPriceMicros: number;
  currency: string;
  ruleConfig?: Record<string, unknown>;
  disabled: boolean;
  updateTime: number;
}

export interface ModelRouteGroup {
  groupKey: string;
  scope: "platform" | "workspace";
  workspaceId: string | null;
  endpointType: string;
  publicModel: string;
  displayName: string;
  disabled: boolean;
  targets: ModelRouteGroupTarget[];
  pricing: LogicalModelPrice | null;
  publication: {
    status: ModelPublicationStatus;
    blockingReasons: string[];
    warnings: string[];
  };
  createTime: number;
  updateTime: number;
}

export interface ModelRouteGroupTargetDraft {
  id?: string | null;
  channelId: string;
  upstreamModel: string;
  tier: ModelRouteTier;
  trafficWeight: number;
  routeRecipe?: Record<string, unknown>;
}

export interface LogicalModelPriceDraft {
  unit: string;
  unitPriceMicros: number;
  currency: "GU";
  ruleConfig: Record<string, unknown>;
}

export interface ModelRouteGroupDraft {
  existingGroupKey?: string | null;
  scope: "platform" | "workspace";
  workspaceId: string | null;
  endpointType: string;
  publicModel: string;
  displayName: string | null;
  disabled: boolean;
  targets: ModelRouteGroupTargetDraft[];
  pricing: LogicalModelPriceDraft | null;
}

export interface ModelRouteGroupPreflight {
  valid: boolean;
  groupKey: string;
  issues: Array<{ path: Array<string | number>; message: string; code: string }>;
  warnings: string[];
  normalizedTargets: Array<ModelRouteGroupTargetDraft & {
    provider: string;
    channelName: string;
    capabilityFingerprint: string;
    normalizedTrafficPercent: number;
  }>;
}

export const endpointLabels: Record<string, string> = {
  text: "文本生成",
  embedding: "文本向量",
  multimodal_embedding: "多模态向量",
  image_generation: "图片生成",
  video_generation: "视频生成",
  video_upscale: "视频超分",
  tts: "语音生成",
  transcription: "语音转写",
  rerank: "重排序",
};

export const endpointPricingUnits: Record<string, Array<{ value: string; label: string }>> = {
  text: [{ value: "token", label: "每百万 Token" }],
  embedding: [{ value: "token", label: "每百万 Token" }],
  multimodal_embedding: [{ value: "token", label: "每百万 Token" }],
  image_generation: [{ value: "image", label: "每张图片" }],
  video_generation: [
    { value: "task", label: "每次任务" },
    { value: "video", label: "每个视频" },
    { value: "token", label: "每 Token 合同" },
  ],
  video_upscale: [{ value: "video", label: "每个视频" }],
  tts: [{ value: "task", label: "每次任务" }],
  transcription: [{ value: "second", label: "每秒" }],
  rerank: [{ value: "document", label: "每文档" }],
};

export function defaultPricingUnit(endpointType: string): string {
  return endpointPricingUnits[endpointType]?.[0]?.value || "task";
}

export function microsToGu(value: number | null | undefined, unit?: string | null): string {
  const amount = unit === "token" ? Number(value || 0) * (1_000_000 / GU_MICROS_PER_GU) : Number(value || 0) / GU_MICROS_PER_GU;
  return amount.toLocaleString("zh-CN", { maximumFractionDigits: 6 });
}

export function guToMicros(value: string, unit?: string | null): number {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(unit === "token" ? amount * (GU_MICROS_PER_GU / 1_000_000) : amount * GU_MICROS_PER_GU);
}
