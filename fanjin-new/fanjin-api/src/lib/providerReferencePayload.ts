import sharp from "sharp";
import type { Metadata } from "sharp";

const MIB = 1024 * 1024;

export const PROVIDER_REFERENCE_LIMITS = Object.freeze({
  maxSourceImageBytes: 32 * MIB,
  maxSourceImagePixels: 40_000_000,
  maxOutputImageDataUrlBytes: 4 * MIB,
  maxAggregateImageDataUrlBytes: 24 * MIB,
  maxProviderPayloadBytes: 48 * MIB,
  maxOutputDimension: 2_048,
});

const SUPPORTED_IMAGE_MIME_TO_FORMAT: Readonly<Record<string, string>> = Object.freeze({
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/tiff": "tiff",
});

export class ProviderReferencePayloadError extends Error {
  status: number;
  statusCode: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ProviderReferencePayloadError";
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}

function failInvalidImage(): never {
  throw new ProviderReferencePayloadError(
    400,
    "reference_image_data_invalid",
    "本地参考图片数据无效或格式不受支持",
  );
}

function failImageTooLarge(): never {
  throw new ProviderReferencePayloadError(
    413,
    "reference_image_payload_too_large",
    "参考图片处理后仍超过供应商请求上限",
  );
}

function strictImageDataUrl(value: string): {
  mimeType: string;
  buffer: Buffer;
} {
  const raw = String(value || "");
  const commaIndex = raw.indexOf(",");
  if (
    !raw.startsWith("data:")
    || commaIndex <= 5
    || raw.slice(0, commaIndex).includes(",")
  ) {
    failInvalidImage();
  }
  const header = raw.slice(5, commaIndex);
  const headerMatch = header.match(/^([^;,]+);base64$/u);
  if (!headerMatch) failInvalidImage();
  if (headerMatch[1] !== headerMatch[1].toLowerCase()) failInvalidImage();
  const mimeType = headerMatch[1].toLowerCase();
  if (!SUPPORTED_IMAGE_MIME_TO_FORMAT[mimeType]) failInvalidImage();

  const base64 = raw.slice(commaIndex + 1);
  const maxEncodedLength = Math.ceil(
    PROVIDER_REFERENCE_LIMITS.maxSourceImageBytes / 3,
  ) * 4;
  if (
    !base64
    || base64.length > maxEncodedLength
    || base64.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(base64)
  ) {
    if (base64.length > maxEncodedLength) failImageTooLarge();
    failInvalidImage();
  }
  const estimatedBytes = (base64.length / 4) * 3
    - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  if (estimatedBytes <= 0) failInvalidImage();
  if (estimatedBytes > PROVIDER_REFERENCE_LIMITS.maxSourceImageBytes) {
    failImageTooLarge();
  }

  const buffer = Buffer.from(base64, "base64");
  if (
    buffer.length !== estimatedBytes
    || buffer.toString("base64") !== base64
  ) {
    failInvalidImage();
  }
  return { mimeType, buffer };
}

function outputDataUrl(buffer: Buffer): string {
  return `data:image/jpeg;base64,${buffer.toString("base64")}`;
}

/**
 * Converts only a local image fallback data URL. Public provider-reachable
 * URLs never pass through this function and remain byte-for-byte unchanged.
 */
export async function compactLocalProviderImageDataUrl(value: string): Promise<string> {
  const { mimeType, buffer } = strictImageDataUrl(value);
  let metadata: Metadata;
  try {
    metadata = await sharp(buffer, {
      failOn: "error",
      limitInputPixels: PROVIDER_REFERENCE_LIMITS.maxSourceImagePixels,
      pages: 1,
      sequentialRead: true,
    }).metadata();
  } catch {
    failInvalidImage();
  }

  const expectedFormat = SUPPORTED_IMAGE_MIME_TO_FORMAT[mimeType];
  const width = Number(metadata.width);
  const height = Number(metadata.height);
  const pages = Number(metadata.pages || 1);
  if (
    metadata.format !== expectedFormat
    || !Number.isInteger(width)
    || !Number.isInteger(height)
    || width <= 0
    || height <= 0
    || width * height > PROVIDER_REFERENCE_LIMITS.maxSourceImagePixels
    || pages !== 1
  ) {
    failInvalidImage();
  }

  const attempts = [
    { dimension: 2_048, quality: 82 },
    { dimension: 1_600, quality: 74 },
    { dimension: 1_280, quality: 66 },
  ] as const;
  for (const attempt of attempts) {
    let output: Buffer;
    try {
      output = await sharp(buffer, {
        failOn: "error",
        limitInputPixels: PROVIDER_REFERENCE_LIMITS.maxSourceImagePixels,
        pages: 1,
        sequentialRead: true,
      })
        .rotate()
        .resize({
          width: attempt.dimension,
          height: attempt.dimension,
          fit: "inside",
          withoutEnlargement: true,
        })
        .flatten({ background: "#ffffff" })
        .jpeg({
          quality: attempt.quality,
          chromaSubsampling: "4:2:0",
          progressive: false,
          mozjpeg: false,
          optimiseCoding: false,
        })
        .toBuffer();
    } catch {
      failInvalidImage();
    }
    const dataUrl = outputDataUrl(output);
    if (
      Buffer.byteLength(dataUrl, "utf8")
      <= PROVIDER_REFERENCE_LIMITS.maxOutputImageDataUrlBytes
    ) {
      return dataUrl;
    }
  }
  return failImageTooLarge();
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function providerMediaPart(
  item: Record<string, unknown>,
  type: "image_url" | "video_url" | "audio_url",
  allowedProviderAssetUris: ReadonlySet<string>,
): Record<string, unknown> {
  const media = plainObject(item[type]);
  const url = typeof media?.url === "string" ? media.url : "";
  if (
    !url
    || url !== url.trim()
    || /[\u0000-\u001f\u007f]/u.test(url)
  ) {
    throw new ProviderReferencePayloadError(
      400,
      "provider_reference_content_invalid",
      "参考素材缺少有效的供应商媒体地址",
    );
  }
  const role = typeof item.role === "string" ? item.role : "";
  const allowedRoles = type === "image_url"
    ? new Set(["reference_image", "first_frame", "last_frame"])
    : type === "video_url"
      ? new Set(["reference_video"])
      : new Set(["reference_audio"]);
  if (!allowedRoles.has(role)) {
    throw new ProviderReferencePayloadError(
      400,
      "provider_reference_role_invalid",
      "参考素材缺少供应商支持的媒体角色",
    );
  }
  const isDataUrl = /^data:/iu.test(url);
  const isProviderAssetUri = /^asset:\/\/[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/u.test(url);
  if (type !== "image_url" && isDataUrl) {
    throw new ProviderReferencePayloadError(
      400,
      "provider_reference_content_invalid",
      "视频或音频参考素材必须使用供应商可访问的地址",
    );
  }
  if (isProviderAssetUri) {
    if (type === "audio_url" || !allowedProviderAssetUris.has(url)) {
      throw new ProviderReferencePayloadError(
        409,
        "provider_reference_asset_binding_invalid",
        "参考素材的人像资产绑定无效或已失效",
      );
    }
  } else if (!isDataUrl) {
    try {
      const parsed = new URL(url);
      if (
        parsed.protocol !== "https:"
        || parsed.username
        || parsed.password
      ) {
        throw new Error("unsupported provider media URL");
      }
    } catch {
      throw new ProviderReferencePayloadError(
        400,
        "provider_reference_content_invalid",
        "参考素材必须使用无凭据的 HTTPS 地址",
      );
    }
  }
  return { type, [type]: { url }, role };
}

/**
 * Provider-boundary normalizer for the official video content schema.
 * Internal `reference_role` remains available to capability validation and
 * auditing in requestPayload, but is never sent upstream.
 */
export function normalizeAndValidateProviderVideoPayload(
  input: Record<string, unknown>,
  options: {
    /** Exact, server-resolved Active provider assets; request input is never trusted here. */
    allowedProviderAssetUris?: ReadonlySet<string>;
  } = {},
): Record<string, unknown> {
  const allowedProviderAssetUris = options.allowedProviderAssetUris ?? new Set<string>();
  const content = input.content;
  if (content !== undefined && !Array.isArray(content)) {
    throw new ProviderReferencePayloadError(
      400,
      "provider_reference_content_invalid",
      "视频供应商 content 必须为数组",
    );
  }

  let aggregateImageBytes = 0;
  const normalizedContent = (content || []).map((rawItem) => {
    const item = plainObject(rawItem);
    if (!item || typeof item.type !== "string") {
      throw new ProviderReferencePayloadError(
        400,
        "provider_reference_content_invalid",
        "视频供应商 content 项格式无效",
      );
    }
    if (item.type === "draft_task") {
      const draft = plainObject(item.draft_task);
      if (!["doubao-seedance-2-5-260628", "dreamina-seedance-2-5-260628"].includes(String(input.model))
        || input.resolution !== "1080p" || content?.length !== 1
        || typeof draft?.id !== "string" || !/^[A-Za-z0-9._:-]{1,512}$/.test(draft.id)
        || ["draft", "duration", "ratio", "generate_audio", "seed", "omni_reference_task_type"].some(key => input[key] !== undefined)) {
        throw new ProviderReferencePayloadError(400, "draft_final_payload_invalid", "样片转正式片参数不符合上游合同");
      }
      return { type: "draft_task", draft_task: { id: draft.id } };
    }
    if (item.type === "text") {
      if (typeof item.text !== "string") {
        throw new ProviderReferencePayloadError(
          400,
          "provider_reference_content_invalid",
          "视频提示词 content 项格式无效",
        );
      }
      return { type: "text", text: item.text };
    }
    if (item.type === "image_url") {
      const normalized = providerMediaPart(item, "image_url", allowedProviderAssetUris);
      const url = String((normalized.image_url as { url: string }).url);
      if (/^data:/iu.test(url)) {
        strictImageDataUrl(url);
        const bytes = Buffer.byteLength(url, "utf8");
        if (bytes > PROVIDER_REFERENCE_LIMITS.maxOutputImageDataUrlBytes) {
          failImageTooLarge();
        }
        aggregateImageBytes += bytes;
        if (aggregateImageBytes > PROVIDER_REFERENCE_LIMITS.maxAggregateImageDataUrlBytes) {
          throw new ProviderReferencePayloadError(
            413,
            "reference_image_payload_aggregate_too_large",
            "参考图片聚合请求超过供应商安全上限",
          );
        }
      }
      return normalized;
    }
    if (item.type === "video_url") {
      return providerMediaPart(item, "video_url", allowedProviderAssetUris);
    }
    if (item.type === "audio_url") {
      return providerMediaPart(item, "audio_url", allowedProviderAssetUris);
    }
    throw new ProviderReferencePayloadError(
      400,
      "provider_reference_content_invalid",
      "视频供应商 content 含有不支持的类型",
    );
  });

  const normalized: Record<string, unknown> = {
    ...input,
    ...(content === undefined ? {} : { content: normalizedContent }),
  };
  delete normalized.reference_role;
  if (
    Buffer.byteLength(JSON.stringify(normalized), "utf8")
    > PROVIDER_REFERENCE_LIMITS.maxProviderPayloadBytes
  ) {
    throw new ProviderReferencePayloadError(
      413,
      "provider_payload_too_large",
      "视频供应商请求体超过安全上限",
    );
  }
  return normalized;
}
