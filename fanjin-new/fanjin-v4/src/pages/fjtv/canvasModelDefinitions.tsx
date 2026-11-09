import type { VideoPromptTab } from "./canvasDataTypes";
import type { NodeData, ModelVisualMeta, VideoGenerationMode, VideoReferenceSummary, VideoPromptTabAvailability } from "./canvasDataTypes";
import type { NodeType, RatioKey } from "./canvasMediaTypes";
import { nearestRatio } from "./canvasMediaGeometry";
import { requiredVideoRatio } from "../../features/quick-create/videoOutputContract";
import { videoDurationLabel } from "../../features/quick-create/AutoVideoDurationButton";
import { getCanvasCatalogAspectRatios, getCanvasCatalogImageQualities, getCanvasCatalogModeInputLimit, getCanvasCatalogVideoDefaultResolution, getCanvasCatalogVideoModes, getCanvasCatalogVideoResolutions, isCanvasCatalogVideoModeSupported, normalizeCanvasAspectRatioForModel, normalizeCanvasCatalogVideoAudio, normalizeCanvasCatalogVideoResolution, normalizeCanvasImageQualityForModel, resolveSelectedCanvasAspectRatio, resolveSelectedCanvasImageQuality, validateCanvasCatalogModeReferenceCounts, type CanvasCatalogImageQuality } from "./canvasCatalogContract";
import { isCanvasSourceVideoMode } from "./canvasVideoExtension";
import { type AiModelOption } from "@/lib/api";
import { getCatalogModelUnavailableMessage, isCatalogModelSelectable } from "./modelCatalog";
import { RATIO_PANEL_ITEMS } from "./canvasPageConstants";

export const VIDEO_PROMPT_TABS = ["文生视频", "全能参考", "图生视频", "首尾帧", "图片参考", "延长视频", "修改视频"] as const;

export const VIDEO_REFERENCE_REQUIREMENT_TEXT: Record<VideoGenerationMode, string> = {
  text_to_video: "",
  omni_reference: "全能参考至少需要 1 个引用素材",
  image_to_video: "图生视频需要 1 张图片引用",
  first_last_frame: "首尾帧需要 2 张图片引用",
  image_reference: "图片参考数量不符合当前模型目录",
  video_extension: "延长视频需要连接 1 段原片，画幅自动跟随原片",
  video_edit: "修改视频需要连接 1 段 4–30 秒原片，画幅和时长跟随原片",
};

export const VIDEO_TAB_HOVER_HINTS: Record<Exclude<VideoPromptTab, "文生视频">, string> = {
  "全能参考": "需要连接图片/视频/音频节点（1~15个）",
  "图生视频": "需要连接图片节点（1个）",
  "首尾帧": "需要连接图片节点（恰好 2 个）",
  "图片参考": "需要连接当前模型目录允许数量的图片节点",
  "延长视频": "连接 1 段原片，填写接续剧情；画幅跟随原片",
  "修改视频": "连接 1 段原片和替换参考图，填写修改与保留要求",
};

export function getNodeModelType(type: NodeType): "image" | "video" | "text" | "audio" {
  if (type === "image") return "image";
  if (type === "video" || type === "compose") return "video";
  if (type === "script") return "text";
  if (type === "audio") return "audio";
  return "text";
}

export function resolutionToLongEdge(resolution: string) {
  const raw = resolution.toLowerCase();
  if (raw.includes("4k")) return 4096;
  if (raw.includes("1080")) return 1080;
  if (raw.includes("720")) return 720;
  if (raw.includes("1k")) return 1024;
  return 2048;
}

export function normalizeNodeResolution(value: string | undefined) {
  const raw = String(value || "2K").toLowerCase();
  // Video public SKUs never include 480; map legacy 480 to 720 for display/submit.
  if (raw.includes("480")) return "720P";
  if (raw.includes("720")) return "720P";
  if (raw.includes("1080")) return "1080P";
  if (raw.includes("1k")) return "1K";
  if (raw.includes("4k")) return "4K";
  if (raw === "2k" || raw.includes("1440")) return "2K";
  return "2K";
}

export function getCatalogRatioPanelItems(model: AiModelOption | null | undefined, mode?: string) {
  const supported = new Set(getCanvasCatalogAspectRatios(model));
  const required = model ? requiredVideoRatio(model.id, mode || "") : null;
  return RATIO_PANEL_ITEMS.filter((item) => (
    item.key === "auto" ? supported.has("adaptive") : supported.has(item.key)
  ) && (!required || item.key === "auto"));
}

export function normalizeNodeRatioForModel(
  model: AiModelOption | null | undefined,
  ratio: RatioKey,
): RatioKey {
  const normalized = normalizeCanvasAspectRatioForModel(model, ratio === "auto" ? "adaptive" : ratio) || ratio;
  return (normalized === "adaptive" ? "auto" : normalized) as RatioKey;
}

export function normalizeImageResolutionForModel(
  model: AiModelOption | null | undefined,
  resolution: string | undefined,
): CanvasCatalogImageQuality | "" {
  return normalizeCanvasImageQualityForModel(model, resolution);
}

export function isSora2Model(modelId: string | undefined) {
  return String(modelId || "").trim() === "sora-2";
}

export function isGrok35VideoModel(modelId: string | undefined) {
  return String(modelId || "").trim() === "grok-video-3.5";
}

export function isLk888LimitedVideoModel(modelId: string | undefined) {
  return isSora2Model(modelId) || isGrok35VideoModel(modelId);
}

export function getLimitedVideoModelLabel(modelId: string | undefined) {
  if (isGrok35VideoModel(modelId)) return "Grok 3.5";
  return "Sora 2";
}

export function isAiModelSelectable(model: AiModelOption) {
  if (!isCatalogModelSelectable(model)) return false;
  if (model.type === "video") {
    return getCapabilityVideoResolutions(model).length > 0
      && getCanvasCatalogVideoModes(model).length > 0
      && getCanvasCatalogAspectRatios(model).length > 0;
  }
  if (model.type === "image") {
    return getCanvasCatalogImageQualities(model).length > 0
      && getCanvasCatalogAspectRatios(model).length > 0;
  }
  return true;
}

export function getAiModelUnavailableMessage(model: AiModelOption) {
  const catalogMessage = getCatalogModelUnavailableMessage(model);
  if (catalogMessage) return catalogMessage;
  if (model.type === "video" && getCapabilityVideoResolutions(model).length === 0) {
    return "模型目录未声明可用清晰度";
  }
  if (model.type === "video" && getCanvasCatalogVideoModes(model).length === 0) {
    return "模型目录未声明可用生成模式";
  }
  if ((model.type === "video" || model.type === "image") && getCanvasCatalogAspectRatios(model).length === 0) {
    return "模型目录未声明可用画面比例";
  }
  if (model.type === "image" && getCanvasCatalogImageQualities(model).length === 0) {
    return "模型目录未声明可用图片清晰度";
  }
  return "";
}

export function resolveCanvasImageQuality(model: AiModelOption, nodeResolution: string | undefined) {
  return resolveSelectedCanvasImageQuality(model, nodeResolution);
}

export function getCapabilityVideoResolutions(model: AiModelOption | undefined) {
  return getCanvasCatalogVideoResolutions(model);
}

export function getVideoResolutionOptions(_modelId: string | undefined, model?: AiModelOption) {
  return getCapabilityVideoResolutions(model);
}

export function getCapabilityVideoDefaultResolution(model: AiModelOption | undefined) {
  return getCanvasCatalogVideoDefaultResolution(model);
}

export function normalizeVideoResolutionForModel(modelId: string | undefined, value: string | undefined, model?: AiModelOption) {
  const normalized = normalizeCanvasCatalogVideoResolution(modelId, value);
  const capabilityResolutions = getCapabilityVideoResolutions(model);
  if (!capabilityResolutions.length) return "";
  if (capabilityResolutions.includes(normalized)) return normalized;
  const configuredDefault = getCapabilityVideoDefaultResolution(model);
  return capabilityResolutions.includes(configuredDefault) ? configuredDefault : capabilityResolutions[0];
}

export function parseDurationSecondsValue(raw?: string) {
  if (String(raw).trim() === "-1" || raw === "自动") return -1;
  if (!raw) return 5;
  const matched = String(raw).match(/\d+(\.\d+)?/);
  if (!matched) return 5;
  const seconds = Number(matched[0]);
  if (!Number.isFinite(seconds) || seconds <= 0) return 5;
  return seconds;
}

export function buildVideoSettingsSummary(node: NodeData, model?: AiModelOption) {
  const resolution = node.videoRenderMode === "draft" ? "样片 · 480P" : normalizeVideoResolutionForModel(node.model, node.resolution, model) || "清晰度未配置";
  const ratio = isCanvasSourceVideoMode(node.videoMode) ? "跟随原片" : resolveSelectedCanvasAspectRatio(model, node.ratio) || "比例未配置";
  return `${ratio} · ${resolution} · ${node.videoMode === "video_edit" ? "原片时长" : videoDurationLabel(parseDurationSecondsValue(node.duration))} · ${normalizeCanvasCatalogVideoAudio(model, node.videoGenerateAudio) ? "音频" : "静音"}`;
}

export function summarizeVideoReferenceNodes(nodes: NodeData[]): VideoReferenceSummary {
  const imageCount = nodes.filter((node) => node.type === "image").length;
  const videoCount = nodes.filter((node) => node.type === "video").length;
  const audioCount = nodes.filter((node) => node.type === "audio").length;
  return {
    imageCount,
    videoCount,
    audioCount,
    totalCount: imageCount + videoCount + audioCount,
    hasImages: imageCount > 0,
    hasVideos: videoCount > 0,
    hasAudios: audioCount > 0,
    hasMixedMedia: imageCount > 0 && (videoCount > 0 || audioCount > 0),
  };
}

export function getDefaultVideoPromptTab(
  summary: VideoReferenceSummary,
  modelId?: string,
  model?: AiModelOption,
): VideoPromptTab {
  const preferred: VideoPromptTab[] = isLk888LimitedVideoModel(modelId)
    ? summary.hasImages
      ? ["图生视频", "文生视频"]
      : ["文生视频", "图生视频"]
    : summary.totalCount > 0
      ? ["全能参考", "图生视频", "首尾帧", "图片参考", "文生视频"]
      : ["文生视频", "图生视频", "首尾帧", "全能参考", "图片参考"];
  return preferred.find((tab) =>
    getVideoPromptTabAvailability(tab, summary, modelId, model).enabled
  ) ?? getVideoTabForMode(getCanvasCatalogVideoModes(model)[0]);
}

export function getVideoPromptTabAvailability(
  tab: VideoPromptTab,
  summary: VideoReferenceSummary,
  modelId?: string,
  model?: AiModelOption,
): VideoPromptTabAvailability {
  if (!isCanvasCatalogVideoModeSupported(model, getVideoModeForTab(tab))) {
    return { enabled: false, hintLines: ["所选模型目录未声明该生成模式"] };
  }
  if (isLk888LimitedVideoModel(modelId)) {
    const modelLabel = getLimitedVideoModelLabel(modelId);
    if (tab === "文生视频") {
      return summary.hasImages
        ? { enabled: false, hintLines: ["已接入图片，默认使用图生视频"] }
        : { enabled: true, hintLines: [] };
    }
    if (tab === "图生视频") {
      if (isGrok35VideoModel(modelId)) {
        if (summary.imageCount >= 1) return { enabled: true, hintLines: summary.hasVideos || summary.hasAudios ? [`${modelLabel} 将只使用已接入图片生成视频`] : [] };
        return { enabled: false, hintLines: [`${modelLabel} 图生视频需要连接至少 1 张图片`] };
      }
      if (summary.imageCount >= 1) return { enabled: true, hintLines: summary.imageCount > 1 || summary.hasVideos || summary.hasAudios ? [`${modelLabel} 将使用第 1 张图片生成视频`] : [] };
      return { enabled: false, hintLines: [`${modelLabel} 图生视频需要连接 1 张图片`] };
    }
    if (tab === "全能参考") return { enabled: false, hintLines: [`${modelLabel} 当前不支持多素材参考`] };
    if (tab === "首尾帧") return { enabled: false, hintLines: [`${modelLabel} 当前不支持首尾帧模式`] };
    return { enabled: false, hintLines: [`${modelLabel} 当前不支持多图参考模式`] };
  }

  const ignoreHints: string[] = [];
  if (summary.hasVideos) ignoreHints.push("该模式将忽略已接入的视频");
  if (summary.hasAudios) ignoreHints.push("该模式将忽略已接入的音频");

  if (tab === "文生视频") {
    return summary.totalCount === 0
      ? { enabled: true, hintLines: [] }
      : { enabled: false, hintLines: ["已接媒体输入，无法使用纯文生视频"] };
  }

  if ((tab === "延长视频" || tab === "修改视频") && summary.videoCount !== 1) {
    return { enabled: false, hintLines: [VIDEO_REFERENCE_REQUIREMENT_TEXT[getVideoModeForTab(tab)]] };
  }
  if (tab === "全能参考" || tab === "延长视频" || tab === "修改视频") {
    if (summary.totalCount < 1) {
      return { enabled: false, hintLines: [VIDEO_TAB_HOVER_HINTS["全能参考"]] };
    }
    const validation = validateCanvasCatalogModeReferenceCounts(
      model,
      getVideoModeForTab(tab),
      {
        image: summary.imageCount,
        video: summary.videoCount,
        file: summary.audioCount,
      },
    );
    return validation.ok
      ? { enabled: true, hintLines: [] }
      : { enabled: false, hintLines: [validation.message] };
  }

  if (tab === "图生视频") {
    if (summary.imageCount === 1 && !summary.hasVideos && !summary.hasAudios) return { enabled: true, hintLines: [] };
    if (summary.hasMixedMedia) return { enabled: false, hintLines: ["当前已接入多类型素材，请改用全能参考"] };
    if (summary.imageCount > 1) return { enabled: false, hintLines: ["图生视频仅支持 1 张图片"] };
    return { enabled: false, hintLines: [VIDEO_TAB_HOVER_HINTS["图生视频"]] };
  }

  if (tab === "首尾帧") {
    if (summary.imageCount === 2 && summary.totalCount === 2) return { enabled: true, hintLines: [] };
    return { enabled: false, hintLines: ["首尾帧需要且仅接受 2 张图片"] };
  }

  const imageReferenceLimit = getCanvasCatalogModeInputLimit(model, "image_reference", "image");
  if (
    imageReferenceLimit
    && summary.totalCount === summary.imageCount
    && summary.imageCount >= imageReferenceLimit.min
    && summary.imageCount <= imageReferenceLimit.max
  ) {
    return { enabled: true, hintLines: [] };
  }
  const limitHint = imageReferenceLimit
    ? `图片参考需要 ${imageReferenceLimit.min}~${imageReferenceLimit.max} 张图片`
    : VIDEO_TAB_HOVER_HINTS["图片参考"];
  return { enabled: false, hintLines: [limitHint] };
}

export function isVideoPromptTabEnabled(
  tab: VideoPromptTab,
  summary: VideoReferenceSummary,
  modelId?: string,
  model?: AiModelOption,
) {
  return getVideoPromptTabAvailability(tab, summary, modelId, model).enabled;
}

export function getModelVisualMeta(model: AiModelOption): ModelVisualMeta {
  if (model.type === "video") return { icon: "bars" };
  if (model.type === "image") return { icon: "image" };
  return { icon: "link" };
}

export function getVideoModeForTab(tab: VideoPromptTab): VideoGenerationMode {
  if (tab === "延长视频") return "video_extension";
  if (tab === "修改视频") return "video_edit";
  if (tab === "全能参考") return "omni_reference";
  if (tab === "图生视频") return "image_to_video";
  if (tab === "首尾帧") return "first_last_frame";
  if (tab === "图片参考") return "image_reference";
  return "text_to_video";
}

export function getVideoTabForMode(mode?: VideoGenerationMode): VideoPromptTab {
  if (mode === "video_extension") return "延长视频";
  if (mode === "video_edit") return "修改视频";
  if (mode === "omni_reference") return "全能参考";
  if (mode === "image_to_video") return "图生视频";
  if (mode === "first_last_frame") return "首尾帧";
  if (mode === "image_reference") return "图片参考";
  return "文生视频";
}

export function getImageRequestRatio(node: NodeData) {
  const naturalWidth = Number(node.mediaNaturalWidth || 0);
  const naturalHeight = Number(node.mediaNaturalHeight || 0);
  if (node.ratio === "auto" && naturalWidth > 0 && naturalHeight > 0) {
    return nearestRatio(naturalWidth, naturalHeight);
  }
  return node.ratio === "auto" ? "1:1" : node.ratio;
}
