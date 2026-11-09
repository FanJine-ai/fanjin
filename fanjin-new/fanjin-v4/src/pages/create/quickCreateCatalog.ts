import type { AttachmentQueueItem } from "../../features/quick-create/attachments/uploadQueue.types";
import { REFERENCE_ATTACHMENT_ACCEPT } from "../../features/quick-create/attachments/api";
import type {
  QuickCreateImageModelOption,
  QuickCreateVideoModelOption,
} from "../../features/quick-create/modelCatalog";
import { normalizeVideoDuration } from "../../features/quick-create/modelCatalog";
import { normalizeDefaultVideoOutputFormat, normalizeVideoOutputFormats, requiredVideoDuration, type VideoOutputFormat } from "../../features/quick-create/videoOutputContract";
import type { QuickCreateImageQuality } from "../../features/quick-create/types";

/**
 * Quick Create deliberately submits one image per paid request. The provider
 * endpoint does not support OpenAI-style `n`, so a higher UI default would make
 * the response look incomplete even though the upstream request succeeded.
 */
export const QUICK_CREATE_IMAGE_DEFAULT_COUNT = 1;

const IMAGE_ATTACHMENT_ACCEPT = REFERENCE_ATTACHMENT_ACCEPT
  .split(",")
  .filter((mimeType) => mimeType.startsWith("image/"))
  .join(",");

const VIDEO_ATTACHMENT_ACCEPT = REFERENCE_ATTACHMENT_ACCEPT
  .split(",")
  .filter((mimeType) => (
    mimeType.startsWith("image/")
    || mimeType.startsWith("video/")
    || mimeType.startsWith("audio/")
  ))
  .join(",");

export function quickCreateAttachmentAccept(entry: string) {
  if (entry === "Agent 模式") return VIDEO_ATTACHMENT_ACCEPT.split(",").filter((mime) => !mime.startsWith("audio/")).join(",");
  return entry === "图片生成" ? IMAGE_ATTACHMENT_ACCEPT : VIDEO_ATTACHMENT_ACCEPT;
}

export function isQuickCreateAttachmentAllowed(
  entry: string,
  attachment: Pick<File, "type"> | Pick<AttachmentQueueItem, "mimeType">,
) {
  const mimeType = ("mimeType" in attachment ? attachment.mimeType : attachment.type)
    .trim()
    .toLowerCase();
  if (entry === "图片生成") return mimeType.startsWith("image/");
  if (entry === "Agent 模式") return mimeType.startsWith("image/") || mimeType.startsWith("video/");
  return mimeType.startsWith("image/")
    || mimeType.startsWith("video/")
    || mimeType.startsWith("audio/");
}

export function quickCreateAttachmentRestrictionText(entry: string) {
  if (entry === "Agent 模式") return "Agent 模式支持最多 4 张图片和 2 个视频参考，暂不接收音频";
  return entry === "图片生成"
    ? "图片生成仅接受图片参考"
    : `${entry}仅接受图片、视频或音频参考`;
}

export function reconcileQuickCreateImageCatalogSelection(
  models: QuickCreateImageModelOption[],
  current: { model: string; quality: QuickCreateImageQuality },
) {
  const available = models.filter((item) => item.canSubmit !== false);
  const model = available.find((item) => item.id === current.model) || available[0] || null;
  return model
    ? {
        model: model.id,
        quality: model.qualities.includes(current.quality)
          ? current.quality
          : model.defaultQuality,
      }
    : { model: "", quality: current.quality };
}

export function reconcileQuickCreateVideoCatalogSelection(
  models: QuickCreateVideoModelOption[],
  current: { model: string; resolution: string; duration: number; audio: boolean; mode?: string; outputFormat?: VideoOutputFormat },
) {
  const available = models.filter((item) => item.canSubmit !== false);
  const model = available.find((item) => item.id === current.model) || available[0] || null;
  if (!model) return { model: "", resolution: "", duration: 5, audio: false, mode: "", outputFormat: "mp4" as const };
  const mode = current.mode && model.modes.includes(current.mode)
    ? current.mode
    : model.modes.includes("text_to_video")
      ? "text_to_video"
      : model.modes[0] || "";
  return {
    model: model.id,
    resolution: model.resolutions.includes(current.resolution)
      ? current.resolution
      : model.defaultResolution,
    duration: requiredVideoDuration(model.id, mode) ?? normalizeVideoDuration(
      current.model !== model.id && model.duration.auto && model.duration.default === -1
        ? -1 : current.duration,
      model.duration,
    ),
    audio: model.supportsGenerateAudio ? current.audio : false,
    mode,
    outputFormat: normalizeDefaultVideoOutputFormat(current.outputFormat || model.defaultOutputFormat,
      normalizeVideoOutputFormats(model.outputFormats)),
  };
}
