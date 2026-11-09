import type { ReferenceUploadProgress } from "./uploadQueue.types";
import { apiPost } from "../../../api/http";
import { uploadReferenceMultipart } from "./referenceMultipart";

export type ReferenceAttachmentMimeCategory = "image" | "video" | "audio" | "document";

export type UploadedReferenceAsset = {
  assetId: number;
  assetVersionId: number;
  filePath: string;
  previewUrl: string;
  type: ReferenceAttachmentMimeCategory;
  mimeType: string;
  size: number;
  name: string;
};

export type UploadReferencePayload = {
  projectId: number;
  /** base64 data URL，例如 "data:image/png;base64,..." */
  base64Data: string;
  /** 参考素材类型：image | video | audio */
  type: ReferenceAttachmentMimeCategory;
  /** 文件名 */
  name: string;
};

/** 支持的 MIME 类型 */
const ALLOWED_MIME_TYPES: Record<string, ReferenceAttachmentMimeCategory> = {
  "image/jpeg": "image",
  "image/jpg": "image",
  "image/png": "image",
  "image/gif": "image",
  "image/webp": "image",
  "video/mp4": "video",
  "video/webm": "video",
  "video/quicktime": "video",
  "audio/mpeg": "audio",
  "audio/mp3": "audio",
  "audio/wav": "audio",
  "audio/mp4": "audio",
  "application/pdf": "document",
  "text/plain": "document",
  "text/markdown": "document",
  "text/x-markdown": "document",
};

export const REFERENCE_ATTACHMENT_ACCEPT = Object.keys(ALLOWED_MIME_TYPES).join(",");
const DOCUMENT_EXTENSION_MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

/** Base64 兼容路径仍限制 20MB；大媒体改走对象存储 multipart。 */
export const MAX_INLINE_REFERENCE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_REFERENCE_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * 从 MIME 类型推断素材类别。
 * 不支持的类型返回 null。
 */
function normalizedUploadMimeType(file: Pick<File, "name" | "type">): string {
  const declared = file.type.toLowerCase().trim();
  if (ALLOWED_MIME_TYPES[declared]) return declared;
  const lowerName = file.name.toLowerCase();
  const extension = Object.keys(DOCUMENT_EXTENSION_MIME_TYPES).find((candidate) => lowerName.endsWith(candidate));
  return extension ? DOCUMENT_EXTENSION_MIME_TYPES[extension] : declared;
}

export function inferMimeCategory(
  mimeType: string,
  fileName = "",
): ReferenceAttachmentMimeCategory | null {
  return ALLOWED_MIME_TYPES[normalizedUploadMimeType({ type: mimeType, name: fileName })] ?? null;
}

/**
 * 校验文件是否可上传。
 * 返回错误消息，null 表示通过。
 */
export function validateUploadFile(file: File): string | null {
  const category = inferMimeCategory(file.type, file.name);
  if (!category) {
    return `不支持的文件类型：${file.type || "未知"}`;
  }
  if (category === "document" && file.size > MAX_INLINE_REFERENCE_ATTACHMENT_BYTES) {
    return `文档过大：${(file.size / 1024 / 1024).toFixed(1)}MB，最大 20MB`;
  }
  if (file.size > MAX_REFERENCE_ATTACHMENT_BYTES) {
    return `文件过大：${(file.size / 1024 / 1024).toFixed(1)}MB，最大 2GB`;
  }
  return null;
}

/**
 * 将 File 转为 base64 data URL。
 */
export function fileToBase64DataUrl(file: File, mimeType = normalizedUploadMimeType(file)): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result.replace(/^data:[^;,]*;/, `data:${mimeType};`));
      } else {
        reject(new Error("文件读取失败"));
      }
    };
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

/**
 * 上传参考素材到项目受控存储。
 * 返回创建的 Asset/AssetVersion 信息。
 */
export async function uploadReferenceAttachment(
  projectId: number,
  file: File,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: number, transfer?: ReferenceUploadProgress) => void;
  } = {},
): Promise<UploadedReferenceAsset> {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new Error("缺少有效的项目 ID");
  }
  const validationError = validateUploadFile(file);
  if (validationError) throw new Error(validationError);
  const mimeType = normalizedUploadMimeType(file);
  const category = inferMimeCategory(mimeType, file.name);
  if (!category) throw new Error(`不支持的文件类型：${file.type}`);

  if (
    category !== "document"
    && file.size > MAX_INLINE_REFERENCE_ATTACHMENT_BYTES
  ) {
    return uploadReferenceMultipart({
      projectId,
      file,
      mediaType: category,
      mimeType,
      signal: options.signal,
      onProgress: options.onProgress,
    });
  }

  options.signal?.throwIfAborted();
  options.onProgress?.(1, { phase: "preparing" });
  const base64Data = await fileToBase64DataUrl(file, mimeType);
  const payload: UploadReferencePayload = {
    projectId,
    base64Data,
    type: category,
    name: file.name,
  };

  const uploaded = await (options.signal || options.onProgress
    ? apiPost<UploadedReferenceAsset, UploadReferencePayload>(
        "/assets/uploadReference",
        payload,
        undefined,
        {
          signal: options.signal,
          ...(options.onProgress ? {
            onUploadProgress: (percent: number) => options.onProgress?.(Math.min(95, Math.max(1, percent * 0.95)), { phase: percent >= 100 ? "saving" : "transferring" }),
          } : {}),
        },
      )
    : apiPost<UploadedReferenceAsset, UploadReferencePayload>(
        "/assets/uploadReference",
        payload,
      ));
  options.onProgress?.(100);
  return uploaded;
}
