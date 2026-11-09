import type { Asset } from "../../api/types";
import type { AttachmentQueueItem } from "../../features/quick-create/attachments/uploadQueue.types";
import type { GenerationReference } from "../../features/quick-create/contracts";
import type { QuickCreateVideoTask } from "../../features/quick-create/types";

export type QuickCreateSubject = {
  id: string;
  numericId: number;
  name: string;
  type: string;
  description: string;
  image?: string;
  assetVersionId?: number;
  mediaType?: "image" | "video";
};

function portraitMediaType(asset: Asset, previewUrl: string | undefined): "image" | "video" | undefined {
  if (asset.type === "video") return "video";
  if (["audio", "document"].includes(asset.type)) return undefined;
  const path = (previewUrl || asset.filePath || "").split(/[?#]/, 1)[0].toLowerCase();
  if (/\.(?:mp4|mov|webm|m4v)$/u.test(path)) return "video";
  return Number.isSafeInteger(Number(asset.imageId)) && Number(asset.imageId) > 0
    ? "image"
    : undefined;
}

export function normalizeQuickCreateError(error: unknown) {
  const details = typeof error === "object" && error !== null && "details" in error
    ? (error as { details?: unknown }).details
    : null;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const requiredGu = Number((details as { requiredGu?: unknown }).requiredGu);
    const availableGu = Number((details as { availableGu?: unknown }).availableGu);
    if (Number.isFinite(requiredGu) && requiredGu >= 0 && Number.isFinite(availableGu) && availableGu >= 0) {
      return `余额不足：预估所需 ${requiredGu} GU，当前可用 ${availableGu} GU`;
    }
  }
  return error instanceof Error ? error.message : "请求失败";
}

export function formatAttachmentSize(size: number) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))}KB`;
  return `${(size / 1024 / 1024).toFixed(1)}MB`;
}

export function attachmentStateText(attachment: AttachmentQueueItem) {
  if (attachment.state === "queued") return "等待上传";
  if (attachment.state === "uploading") {
    if (attachment.transfer?.phase === "preparing") return "正在准备上传";
    if (attachment.transfer?.phase === "saving") return "正在保存素材";
    const percent = Math.max(0, Math.min(99, Math.round(attachment.progress)));
    return `正在上传 · ${percent}%`;
  }
  if (attachment.state === "uploaded") return "已上传";
  if (attachment.state === "failed") return attachment.error || "上传失败";
  return "已移除";
}

export function quickCreateAssetTypeLabel(type: Asset["type"]) {
  const labels: Record<Asset["type"], string> = {
    role: "人物资产",
    tool: "道具资产",
    scene: "场景资产",
    clip: "参考素材",
    audio: "音频资产",
    image: "图片资产",
    video: "视频资产",
    document: "文档资产",
  };
  return labels[type] || "项目资产";
}

export function toQuickCreateSubject(asset: Asset): QuickCreateSubject {
  const image = asset.src || asset.sonAssets?.find((item) => item.src)?.src || undefined;
  const assetVersionId = Number(asset.imageId);
  return {
    id: `asset-${asset.id}`,
    numericId: asset.id,
    name: asset.name || `资产 ${asset.id}`,
    type: quickCreateAssetTypeLabel(asset.type),
    description: asset.describe || asset.prompt || asset.remark || "来自当前项目资产库",
    image,
    ...(Number.isSafeInteger(assetVersionId) && assetVersionId > 0
      ? { assetVersionId, mediaType: portraitMediaType(asset, image) }
      : {}),
  };
}

export function generationReferences(attachments: AttachmentQueueItem[]): GenerationReference[] {
  return attachments
    .filter((attachment) => attachment.state === "uploaded" && attachment.asset)
    .map((attachment) => ({
      assetVersionId: String(attachment.asset!.assetVersionId),
      role: "subject" as const,
    }));
}

export function getTaskStatusText(status: QuickCreateVideoTask["status"]) {
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

export function getNextOption<T>(options: readonly T[], current: T) {
  const index = options.findIndex((option) => option === current);
  return options[(index + 1) % options.length] ?? options[0];
}

export function attachmentTransferredText(attachment: AttachmentQueueItem): string | undefined {
  const bytes = attachment.transfer?.uploadedBytes;
  if (attachment.state !== "uploading" || bytes == null || attachment.transfer?.phase === "preparing") return undefined;
  return `${(Math.max(0, Math.min(bytes, attachment.size)) / 1024 / 1024).toFixed(1)} MB / ${(attachment.size / 1024 / 1024).toFixed(1)} MB`;
}
