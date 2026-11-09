import type { UploadedReferenceAsset } from "./api";

export type ReferenceUploadProgress = {
  phase: "preparing" | "transferring" | "saving";
  /** Actual file bytes reported by multipart transfer; omitted for the JSON upload path. */
  uploadedBytes?: number;
};

export type AttachmentUploadState = "queued" | "uploading" | "uploaded" | "failed" | "removed";

export type AttachmentQueueItem = {
  /** 客户端生成的唯一 ID */
  clientId: string;
  /** 文件对象（上传完成后可释放） */
  file: File | null;
  /** 文件名 */
  name: string;
  /** 文件大小 */
  size: number;
  /** MIME 类型 */
  mimeType: string;
  /** 本地预览 URL（blob:） */
  previewUrl: string;
  /** 待 clear/remove 时释放的本地 Object URL；服务端 URL 不写入这里。 */
  localPreviewUrl?: string;
  /** 上传状态 */
  state: AttachmentUploadState;
  /** 服务端返回的 Asset 信息（uploaded 状态） */
  asset?: UploadedReferenceAsset;
  /** 错误信息（failed 状态） */
  error?: string;
  /** 上传进度 0-100 */
  progress: number;
  transfer?: ReferenceUploadProgress;
  durationSeconds?: number;
};

export type AttachmentUploadResult = {
  uploaded: number;
  failed: number;
  failedClientIds: string[];
};
