import type { Asset } from "../../api/types";
import type {
  NormalizedCapabilityStatus,
} from "../../features/quick-create/videoCapabilities";
import type { QuickCreateVideoTask } from "../../features/quick-create/types";
import type { GenerateAttachmentKind } from "./generateCatalog";

export type GenerateSubject = {
  id: string;
  name: string;
  type: string;
  description: string;
  image?: string;
  numericId?: number;
  assetVersionId?: number;
  mediaType?: "image" | "video";
};

function positiveAssetVersionId(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function assetVersionIdFor(asset: Asset): number | undefined {
  const direct = positiveAssetVersionId(asset.imageId);
  if (direct) return direct;
  const projectReference = (asset as Asset & {
    projectReference?: { assetVersionId?: unknown } | null;
  }).projectReference;
  const pinned = /^image:(\d+)$/.exec(String(projectReference?.assetVersionId || ""));
  return positiveAssetVersionId(pinned?.[1]);
}

function portraitMediaType(asset: Asset, previewUrl: string | undefined): "image" | "video" | undefined {
  if (asset.type === "video") return "video";
  if (asset.type === "image") return "image";
  if (["audio", "document"].includes(asset.type)) return undefined;
  const path = (previewUrl || asset.filePath || "").split(/[?#]/, 1)[0].toLowerCase();
  if (/\.(?:mp4|mov|webm|m4v)$/u.test(path)) return "video";
  return Number.isSafeInteger(Number(asset.imageId)) && Number(asset.imageId) > 0
    ? "image"
    : undefined;
}

export function formatConversationTime(value: number) {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function formatMessageTime(value: number) {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export function formatAttachmentSize(size: number) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))}KB`;
  return `${(size / 1024 / 1024).toFixed(1)}MB`;
}

export function getAssetTypeLabel(type: Asset["type"]) {
  const map: Record<Asset["type"], string> = {
    role: "人物资产",
    tool: "道具资产",
    scene: "场景资产",
    clip: "参考素材",
    audio: "音频资产",
    image: "云存储图片",
    video: "云存储视频",
    document: "云存储文档",
  };
  return map[type] || "项目资产";
}

export function toGenerateSubject(asset: Asset): GenerateSubject {
  const image = asset.src || asset.sonAssets?.find((item) => item.src)?.src || undefined;
  const assetVersionId = assetVersionIdFor(asset);
  return {
    id: `asset-${asset.id}`,
    numericId: asset.id,
    name: asset.name || `资产 ${asset.id}`,
    type: getAssetTypeLabel(asset.type),
    description: asset.describe || asset.prompt || asset.remark || "来自项目资产库，可作为生成参考",
    image,
    ...(assetVersionId
      ? { assetVersionId, mediaType: portraitMediaType(asset, image) }
      : {}),
  };
}

export function resolveGenerateSubjectReference(
  subject: GenerateSubject,
  assets: readonly Asset[],
): (GenerateSubject & Required<Pick<GenerateSubject, "assetVersionId" | "mediaType">>) | null {
  const currentAsset = subject.numericId
    ? assets.find((asset) => Number(asset.id) === Number(subject.numericId))
    : undefined;
  const current = currentAsset ? toGenerateSubject(currentAsset) : subject;
  if (!current.assetVersionId || !current.mediaType) return null;
  return current as GenerateSubject & Required<Pick<GenerateSubject, "assetVersionId" | "mediaType">>;
}

export function taskStatusText(status: QuickCreateVideoTask["status"]) {
  const map: Record<QuickCreateVideoTask["status"], string> = {
    queued: "排队中",
    running: "生成中",
    enhancing: "增强中",
    pending_reconcile: "同步结果中",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return map[status] || status;
}

export function capabilityStatusText(status: NormalizedCapabilityStatus) {
  if (status === "verified") return "能力已验证";
  if (status === "configured") return "能力已配置";
  if (status === "legacy") return "旧服务兼容";
  return "待验证 · 禁止提交";
}

export function videoAttachmentKindText(kind: GenerateAttachmentKind) {
  if (kind === "image") return "图片";
  if (kind === "video") return "视频";
  return "文件";
}

export function scrollElementIntoView(
  element: Element | null,
  options?: ScrollIntoViewOptions,
) {
  const scrollIntoView = (element as (Element & {
    scrollIntoView?: (options?: ScrollIntoViewOptions) => void;
  }) | null)?.scrollIntoView;
  if (typeof scrollIntoView === "function") scrollIntoView.call(element, options);
}
