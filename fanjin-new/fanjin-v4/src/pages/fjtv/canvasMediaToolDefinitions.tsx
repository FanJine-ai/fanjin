import type { VideoEnhanceVersion, VideoEnhanceResolution, VideoEnhanceFrameRate, VideoSubtitleEraseType, VideoFrameExtractMode, AudioSeparateRole } from "./canvasDataTypes";
import type { ImageOutpaintRatioMode, ImageOutpaintResolution } from "./canvasMediaTypes";

export const VIDEO_ENHANCE_MODEL = "HuoShan-画质增强";

export const VIDEO_ENHANCE_RESOLUTIONS: VideoEnhanceResolution[] = ["720P", "1080P", "2K", "4K"];

export const VIDEO_ENHANCE_FRAME_RATES: VideoEnhanceFrameRate[] = ["original", "24", "30", "60", "90", "120"];

export function videoEnhanceResolutionRank(value: string) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized.includes("4k") || normalized.includes("2160")) return 4;
  if (normalized.includes("2k") || normalized.includes("1440")) return 3;
  if (normalized.includes("1080")) return 2;
  if (normalized.includes("720")) return 1;
  return 0;
}

export const VIDEO_SUBTITLE_ERASE_MODEL = "HuoShan-智能去字幕";

export const IMAGE_ENHANCE_MODEL_FALLBACK = "HuoShan-图像画质增强";

export const IMAGE_ENHANCE_MODEL = IMAGE_ENHANCE_MODEL_FALLBACK;

export const IMAGE_ENHANCE_FACTORS_STANDARD = [1, 2, 4, 6, 8] as const;

export const IMAGE_ENHANCE_FACTORS_PROFESSIONAL = [1, 2, 4, 6, 8, 12, 16, 20, 24, 30] as const;

export const IMAGE_OUTPAINT_RATIO_ITEMS: Array<{ key: ImageOutpaintRatioMode; label: string }> = [
  { key: "original", label: "原图比例" },
  { key: "1:1", label: "1:1" },
  { key: "4:3", label: "4:3" },
  { key: "3:4", label: "3:4" },
  { key: "16:9", label: "16:9" },
  { key: "9:16", label: "9:16" },
  { key: "custom", label: "自定义" },
];

export const IMAGE_OUTPAINT_RESOLUTION_ITEMS: ImageOutpaintResolution[] = ["1K", "2K", "4K"];

export function formatVideoEnhanceFrameRate(value: VideoEnhanceFrameRate | undefined) {
  if (!value || value === "original") return "原始帧率";
  return `${value}fps`;
}

export function formatVideoEnhanceVersion(value: VideoEnhanceVersion | undefined) {
  return value === "professional" ? "专业版" : "标准版";
}

export function buildVideoEnhanceNodeTitle(resolution: VideoEnhanceResolution | undefined) {
  return `高清（${resolution || "1080P"}）`;
}

export function buildVideoSubtitleEraseNodeTitle(sourceTitle: string, type: VideoSubtitleEraseType) {
  return type === "region" ? `框选擦除-${sourceTitle}` : `一键去字幕-${sourceTitle}`;
}

export function buildVideoFrameNodeTitle(sourceTitle: string, mode: VideoFrameExtractMode) {
  if (mode === "first") return `${sourceTitle} - 首帧`;
  if (mode === "last") return `${sourceTitle} - 尾帧`;
  return `${sourceTitle} - 当前帧`;
}

export function buildAudioSeparateNodeTitle(sourceTitle: string, role: AudioSeparateRole) {
  if (role === "voice") return `${sourceTitle} - 音轨`;
  if (role === "bgm") return `${sourceTitle} - 音轨 - 背景音`;
  return `${sourceTitle} - 无声`;
}
