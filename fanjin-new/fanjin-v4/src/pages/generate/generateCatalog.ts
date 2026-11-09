import { GU_MICROS_PER_GU } from "@/utils/billingUnits";
import {
  enabledQuickCreateGenerationModes,
  isQuickCreateGenerationModeEnabled,
  normalizeQuickCreateGenerationMode,
  quickCreateGenerationModeId,
  type QuickCreateGenerationMode,
} from "../../features/quick-create/capabilities";
import type { ImageQuality } from "../../features/quick-create/videoCapabilities";
import type {
  AgentChatModel,
  AgentSurfaceAvailability,
} from "../../features/agent-runtime/types";
import { buildGenerateSearch } from "../../features/agent-runtime/url";
import type { StudioContextReference } from "../../components/project-studio";

export type GenerateMode = QuickCreateGenerationMode;
export type GenerateAttachmentKind = "image" | "video" | "file";
type GenerateAttachmentDescriptor = { kind: GenerateAttachmentKind; type: string };
type VideoInputSlot = { accepts: GenerateAttachmentKind[] };

const modes: readonly GenerateMode[] = enabledQuickCreateGenerationModes();

export const EMPTY_AGENT_CAPABILITIES: AgentSurfaceAvailability["capabilities"] = {
  chat: false,
  tools: false,
  imageGeneration: false,
  videoGeneration: false,
};

export type GenerateRuntimeAvailability = {
  agent: boolean;
  image: boolean;
  video: boolean;
  llm: boolean;
};

export type AgentSurfaceExecutionState = {
  conversationAvailable: boolean;
  complete: boolean;
  degraded: boolean;
  capabilities: AgentSurfaceAvailability["capabilities"];
  models: AgentChatModel[];
};

const AGENT_SURFACE_CACHE_KEY_PREFIX = "fanjin-agent-surface:v1";
type AgentSurfaceCacheStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function agentSurfaceCacheKey(scope: string | null) {
  return scope ? `${AGENT_SURFACE_CACHE_KEY_PREFIX}:${scope}` : null;
}

function isAgentSurfaceAvailability(value: unknown): value is AgentSurfaceAvailability {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AgentSurfaceAvailability>;
  const capabilities = candidate.capabilities;
  return typeof candidate.available === "boolean"
    && (candidate.reason === null || typeof candidate.reason === "string")
    && (candidate.message === null || typeof candidate.message === "string")
    && Boolean(capabilities)
    && typeof capabilities?.chat === "boolean"
    && typeof capabilities?.tools === "boolean"
    && typeof capabilities?.imageGeneration === "boolean"
    && typeof capabilities?.videoGeneration === "boolean"
    && Array.isArray(candidate.models)
    && candidate.models.every((model) => (
      Boolean(model)
      && typeof model === "object"
      && typeof model.id === "string"
      && typeof model.displayName === "string"
    ));
}

export function readCachedAgentSurface(
  key: string | null,
  storage?: AgentSurfaceCacheStorage,
): AgentSurfaceAvailability | null {
  if (!key) return null;
  let cache = storage ?? null;
  try {
    cache ??= typeof window === "undefined" ? null : window.localStorage;
    if (!cache) return null;
    const value = JSON.parse(cache.getItem(key) || "null");
    if (!isAgentSurfaceAvailability(value)) {
      cache.removeItem(key);
      return null;
    }
    return value;
  } catch {
    try {
      cache?.removeItem(key);
    } catch {
      // Ignore storage access failures in SSR/private browsing contexts.
    }
    return null;
  }
}

export function writeCachedAgentSurface(
  key: string | null,
  value: AgentSurfaceAvailability,
  storage?: AgentSurfaceCacheStorage,
) {
  if (!key || !isAgentSurfaceAvailability(value)) return;
  try {
    const cache = storage ?? (typeof window === "undefined" ? null : window.localStorage);
    if (!cache) return;
    cache.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing/storage quota failures must not turn a successful
    // server refresh into a false "all services unavailable" state.
  }
}

export function agentChatModelPriceLabel(
  model: Pick<
    AgentChatModel,
    "free" | "priceMicros" | "billingMode" | "reservationMicros" | "estimatedCostMicros"
  >,
): string {
  if (model.billingMode === "token") {
    const reservationGu = Number(model.reservationMicros || 0) / GU_MICROS_PER_GU;
    const estimatedGu = Number(model.estimatedCostMicros || 0) / GU_MICROS_PER_GU;
    const parts = ["按实际 Token 结算"];
    if (reservationGu > 0) parts.push(`预扣 ${formatGu(reservationGu)} GU`);
    if (estimatedGu > 0) parts.push(`基准预估 ${formatGu(estimatedGu)} GU`);
    return parts.join(" · ");
  }
  if (model.billingMode === "usage") return "按实际用量计费";
  if (model.billingMode === "run_plus_usage") {
    return `${formatGu(Number(model.priceMicros || 0) / GU_MICROS_PER_GU)} GU/轮附加费 + 用量费`;
  }
  const legacyPriceMicros = Number(model.priceMicros || 0);
  if (model.free || !(legacyPriceMicros > 0)) return "免费";
  return `${formatGu(legacyPriceMicros / GU_MICROS_PER_GU)} GU/轮`;
}

function formatGu(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

export function reusableImageQuality(metadata: Record<string, unknown> | undefined): ImageQuality | null {
  for (const value of [
    metadata?.requestedResolution,
    metadata?.resolution,
    metadata?.finalResolution,
    metadata?.quality,
  ]) {
    const normalized = String(value || "").trim().toUpperCase();
    if (normalized === "1K" || normalized === "2K" || normalized === "4K") return normalized;
  }
  return null;
}

export function reusableVideoResolution(metadata: Record<string, unknown> | undefined): string {
  return String(
    metadata?.requestedResolution
    || metadata?.resolution
    || metadata?.finalResolution
    || "",
  ).trim().toLowerCase();
}

export function reusableVideoDuration(metadata: Record<string, unknown> | undefined): number {
  const seconds = Number(metadata?.durationSeconds);
  if (Number.isFinite(seconds) && seconds > 0) return seconds;
  const milliseconds = Number(metadata?.durationMs);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds / 1000 : 0;
}

export function modeFromSearch(search: string): GenerateMode {
  const params = new URLSearchParams(search);
  const requestedMode = normalizeQuickCreateGenerationMode(
    params.get("mode") || params.get("ai_feature_name"),
  );
  return requestedMode && isQuickCreateGenerationModeEnabled(requestedMode)
    ? requestedMode
    : "Agent 模式";
}

export function isGenerationModeAvailableOnSurface(mode: GenerateMode, embedded: boolean): boolean {
  return isQuickCreateGenerationModeEnabled(mode) && (!embedded || mode === "Agent 模式");
}

export function generationModesForSurface(embedded: boolean): readonly GenerateMode[] {
  return modes.filter((mode) => isGenerationModeAvailableOnSurface(mode, embedded));
}

export function resolveAgentSurfaceExecutionState(
  result: AgentSurfaceAvailability | null | undefined,
): AgentSurfaceExecutionState {
  const capabilities = { ...EMPTY_AGENT_CAPABILITIES, ...(result?.capabilities || {}) };
  const models = capabilities.chat && Array.isArray(result?.models)
    ? result.models.filter((model) => model.available !== false)
    : [];
  const conversationAvailable = capabilities.chat && capabilities.tools && models.length > 0;
  const complete = result?.available === true
    && conversationAvailable
    && capabilities.imageGeneration
    && capabilities.videoGeneration;
  return {
    conversationAvailable,
    complete,
    degraded: conversationAvailable && !complete,
    capabilities,
    models,
  };
}

export function generationModesForRuntime(
  embedded: boolean,
  availability: GenerateRuntimeAvailability,
): readonly GenerateMode[] {
  return generationModesForSurface(embedded).filter((mode) => {
    if (mode === "Agent 模式") return true;
    if (mode === "图片生成") return availability.image;
    if (mode === "视频生成") return availability.video && availability.llm;
    return false;
  });
}

export function generateAttachmentType(file: Pick<File, "name" | "type">) {
  if (file.type.trim()) return file.type.toLowerCase();
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith(".pdf")) return "application/pdf";
  if (lowerName.endsWith(".txt")) return "text/plain";
  if (lowerName.endsWith(".md")) return "text/markdown";
  return "application/octet-stream";
}

export function generateAttachmentKind(type: string): GenerateAttachmentKind {
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  return "file";
}

export function isGenerateAttachmentAllowed(
  mode: GenerateMode,
  attachment: GenerateAttachmentDescriptor,
  videoInputSlots: VideoInputSlot[] = [],
) {
  if (mode === "Agent 模式") {
    return attachment.kind === "image"
      || attachment.kind === "video"
      || attachment.type === "application/pdf"
      || attachment.type.startsWith("text/");
  }
  if (mode === "图片生成") return attachment.kind === "image";
  if (mode === "视频生成") {
    if (attachment.kind === "file" && !attachment.type.startsWith("audio/")) return false;
    return videoInputSlots.some((slot) => slot.accepts.includes(attachment.kind));
  }
  return false;
}

export function generateAttachmentAccept(mode: GenerateMode, videoInputSlots: VideoInputSlot[] = []) {
  if (mode === "Agent 模式") return "image/*,video/*,.pdf,.txt,.md";
  if (mode === "图片生成") return "image/*";
  const accepts = new Set(videoInputSlots.flatMap((slot) => slot.accepts));
  return [
    accepts.has("image") ? "image/*" : "",
    accepts.has("video") ? "video/*" : "",
    accepts.has("file") ? "audio/*" : "",
  ].filter(Boolean).join(",");
}

export function agentAttachmentUseText(attachment: GenerateAttachmentDescriptor): string {
  if (attachment.kind === "video") return "生成参考 · 不解析视频内容";
  if (attachment.kind === "image") return "读取图片内容";
  if (attachment.type === "application/pdf" || attachment.type.startsWith("text/")) return "读取文档文本";
  return "当前 Agent 不读取此附件";
}

export function isAgentSessionReferenceAllowed(reference: Pick<StudioContextReference, "kind">): boolean {
  return !String(reference.kind || "").toLowerCase().includes("audio")
    && !String(reference.kind || "").includes("音频");
}

export function agentReferenceDisplayKind(kind: string | null | undefined): string {
  const normalized = String(kind || "").toLowerCase();
  if (normalized.includes("video") || String(kind || "").includes("视频")) return "视频生成参考（不解析内容）";
  if (normalized.includes("image") || String(kind || "").includes("图片")) return "图片（读取内容）";
  if (normalized.includes("document") || normalized.includes("file") || String(kind || "").includes("文件")) {
    return "文档（读取文本）";
  }
  if (normalized.includes("audio") || String(kind || "").includes("音频")) return "音频参考（不转写或解析）";
  return String(kind || "参考文件");
}

export function agentConversationBelongsToProject(
  conversation: { projectId: string | null } | null | undefined,
  projectId: number | null,
) {
  if (!conversation) return false;
  if (projectId === null) return conversation.projectId === null;
  return String(conversation.projectId || "") === String(projectId);
}

export function buildGenerateSurfaceSearch(
  search: string,
  mode: GenerateMode,
  threadId: string | null | undefined,
  embedded: boolean,
): string {
  if (!embedded) return buildGenerateSearch(search, quickCreateGenerationModeId(mode), threadId);
  const params = new URLSearchParams(search);
  const normalizedThreadId = threadId?.trim() || null;
  params.delete("ai_feature_name");
  params.delete("thread");
  if (normalizedThreadId) params.set("threadId", normalizedThreadId);
  else params.delete("threadId");
  const nextSearch = params.toString();
  return nextSearch ? `?${nextSearch}` : "";
}
