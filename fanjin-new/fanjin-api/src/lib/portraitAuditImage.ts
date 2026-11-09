import sharp from "sharp";
import type { Metadata } from "sharp";

import u from "@/utils";

const MIB = 1024 * 1024;

/**
 * ImageX `SingleImageAudit` / `GetImageDetectResult` download the caller-supplied
 * HTTPS URI. Large RGBA PNGs (multi-MB) reliably fail the audit backend with
 * `InternalError.RTCAudit` even when face detection on the same URL succeeds.
 * Prepare a compact RGB JPEG derivative before dispatch so provider limits are
 * not confused with content policy decisions.
 */
export const PORTRAIT_AUDIT_IMAGE_LIMITS = Object.freeze({
  maxSourceBytes: 32 * MIB,
  maxSourcePixels: 40_000_000,
  // Keep well under typical content-audit download budgets.
  maxSafeBytes: 2 * MIB,
  maxSafeDimension: 2_048,
  jpegQuality: 82,
  fetchTimeoutMs: 25_000,
});

export type PortraitAuditImagePlan = Readonly<{
  needed: boolean;
  reason: "ok" | "too_large" | "too_many_pixels" | "alpha_channel" | "unsupported_format" | "animated";
  sourceBytes: number;
  width: number | null;
  height: number | null;
  format: string | null;
  hasAlpha: boolean;
}>;

export type PreparedPortraitAuditImage = Readonly<{
  imageUri: string;
  plan: PortraitAuditImagePlan;
  derivative: boolean;
  derivativePath: string | null;
}>;

export class PortraitAuditImageError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PortraitAuditImageError";
    this.code = code;
  }
}

function auditCachePath(sourceSha256: string): string {
  return `portrait-audit-cache/${sourceSha256.slice(0, 2)}/${sourceSha256}.jpg`;
}

export function planPortraitAuditImage(input: {
  buffer: Buffer;
  metadata: Metadata | null;
}): PortraitAuditImagePlan {
  const sourceBytes = input.buffer.byteLength;
  const metadata = input.metadata;
  const width = Number.isInteger(metadata?.width) ? Number(metadata?.width) : null;
  const height = Number.isInteger(metadata?.height) ? Number(metadata?.height) : null;
  const format = metadata?.format ?? null;
  const hasAlpha = Boolean(metadata?.hasAlpha);
  const pages = Number(metadata?.pages || 1);

  if (sourceBytes > PORTRAIT_AUDIT_IMAGE_LIMITS.maxSourceBytes) {
    return {
      needed: true,
      reason: "too_large",
      sourceBytes, width, height, format, hasAlpha,
    };
  }
  if (width != null && height != null && width * height > PORTRAIT_AUDIT_IMAGE_LIMITS.maxSourcePixels) {
    return {
      needed: true,
      reason: "too_many_pixels",
      sourceBytes, width, height, format, hasAlpha,
    };
  }
  if (pages > 1) {
    return { needed: true, reason: "animated", sourceBytes, width, height, format, hasAlpha };
  }
  if (!format || !["jpeg", "png", "webp"].includes(format)) {
    return {
      needed: true,
      reason: "unsupported_format",
      sourceBytes, width, height, format, hasAlpha,
    };
  }
  if (hasAlpha) {
    return { needed: true, reason: "alpha_channel", sourceBytes, width, height, format, hasAlpha };
  }
  if (sourceBytes > PORTRAIT_AUDIT_IMAGE_LIMITS.maxSafeBytes) {
    return { needed: true, reason: "too_large", sourceBytes, width, height, format, hasAlpha };
  }
  if (
    width != null
    && height != null
    && Math.max(width, height) > PORTRAIT_AUDIT_IMAGE_LIMITS.maxSafeDimension
  ) {
    return { needed: true, reason: "too_large", sourceBytes, width, height, format, hasAlpha };
  }
  return {
    needed: false,
    reason: "ok",
    sourceBytes, width, height, format, hasAlpha,
  };
}

/**
 * Produce a provider-safe JPEG for content audit. Never mutates the stored
 * original asset; the derivative lives under a content-addressed cache path.
 */
export async function normalizePortraitAuditImageBuffer(input: {
  buffer: Buffer;
  signal?: AbortSignal;
}): Promise<Buffer> {
  const pipeline = sharp(input.buffer, {
    failOn: "error",
    limitInputPixels: PORTRAIT_AUDIT_IMAGE_LIMITS.maxSourcePixels,
    pages: 1,
    sequentialRead: true,
  })
    .rotate()
    .resize({
      width: PORTRAIT_AUDIT_IMAGE_LIMITS.maxSafeDimension,
      height: PORTRAIT_AUDIT_IMAGE_LIMITS.maxSafeDimension,
      fit: "inside",
      withoutEnlargement: true,
    })
    .flatten({ background: "#ffffff" })
    .jpeg({
      quality: PORTRAIT_AUDIT_IMAGE_LIMITS.jpegQuality,
      chromaSubsampling: "4:2:0",
      progressive: false,
      mozjpeg: false,
      optimiseCoding: false,
    });
  return pipeline.toBuffer({ resolveWithObject: false });
}

async function downloadSource(sourceUrl: string, signal?: AbortSignal): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PORTRAIT_AUDIT_IMAGE_LIMITS.fetchTimeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(sourceUrl, {
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new PortraitAuditImageError(
        "PORTRAIT_AUDIT_IMAGE_DOWNLOAD_FAILED",
        `素材检查镜像下载失败（HTTP ${response.status}）`,
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength <= 0) {
      throw new PortraitAuditImageError(
        "PORTRAIT_AUDIT_IMAGE_DOWNLOAD_EMPTY",
        "素材检查镜像下载结果为空",
      );
    }
    if (buffer.byteLength > PORTRAIT_AUDIT_IMAGE_LIMITS.maxSourceBytes) {
      throw new PortraitAuditImageError(
        "PORTRAIT_AUDIT_IMAGE_TOO_LARGE",
        "素材检查镜像超过可处理大小上限",
      );
    }
    return buffer;
  } catch (error) {
    if (error instanceof PortraitAuditImageError) throw error;
    if (signal?.aborted) throw error;
    throw new PortraitAuditImageError(
      "PORTRAIT_AUDIT_IMAGE_DOWNLOAD_FAILED",
      "素材检查镜像下载失败，请稍后重试",
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function metadataOrNull(buffer: Buffer, signal?: AbortSignal): Promise<Metadata | null> {
  try {
    return await sharp(buffer, {
      failOn: "error",
      limitInputPixels: PORTRAIT_AUDIT_IMAGE_LIMITS.maxSourcePixels,
      pages: 1,
      sequentialRead: true,
    }).metadata();
  } catch {
    return null;
  } finally {
    signal?.throwIfAborted();
  }
}

/**
 * Return a URI that ImageX content audit can consume. When the source is
 * already provider-safe the original URI is returned unchanged. Otherwise a
 * flattened, resized JPEG derivative is cached under `portrait-audit-cache/`
 * and addressed by the original content hash.
 */
export async function preparePortraitAuditImage(input: {
  sourceSha256: string;
  sourceUrl: string;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<PreparedPortraitAuditImage> {
  const sourceSha256 = String(input.sourceSha256 || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) {
    throw new PortraitAuditImageError(
      "PORTRAIT_AUDIT_IMAGE_HASH_INVALID",
      "素材检查镜像内容哈希无效",
    );
  }
  const sourceUrl = String(input.sourceUrl || "").trim();
  if (!/^https:\/\//i.test(sourceUrl)) {
    throw new PortraitAuditImageError(
      "PORTRAIT_AUDIT_IMAGE_URL_INVALID",
      "素材检查镜像地址无效",
    );
  }

  const derivativePath = auditCachePath(sourceSha256);
  try {
    const existing = await u.oss.getFileMetadata(derivativePath);
    if (existing && existing.sizeBytes > 0) {
      return Object.freeze({
        imageUri: await u.oss.getPrivateFileUrl(derivativePath, { expiresInSeconds: 300 }),
        plan: {
          needed: true,
          reason: "too_large" as const,
          sourceBytes: existing.sizeBytes,
          width: null,
          height: null,
          format: "jpeg" as string | null,
          hasAlpha: false,
        },
        derivative: true,
        derivativePath,
      });
    }
  } catch {
    // Cache miss is the normal path; continue to download and normalize.
  }

  const buffer = await downloadSource(sourceUrl, input.signal);
  const metadata = await metadataOrNull(buffer, input.signal);
  const plan = planPortraitAuditImage({ buffer, metadata });
  if (!plan.needed) {
    return Object.freeze({
      imageUri: sourceUrl,
      plan,
      derivative: false,
      derivativePath: null,
    });
  }

  let normalized: Buffer;
  try {
    normalized = await normalizePortraitAuditImageBuffer({ buffer, signal: input.signal });
  } catch {
    throw new PortraitAuditImageError(
      "PORTRAIT_AUDIT_IMAGE_NORMALIZE_FAILED",
      "素材检查镜像压缩或格式修正失败",
    );
  }
  if (normalized.byteLength <= 0 || normalized.byteLength > PORTRAIT_AUDIT_IMAGE_LIMITS.maxSafeBytes * 2) {
    throw new PortraitAuditImageError(
      "PORTRAIT_AUDIT_IMAGE_NORMALIZE_FAILED",
      "素材检查镜像压缩结果无效",
    );
  }

  await u.oss.writeFile(derivativePath, normalized, input.signal ? { signal: input.signal } : {});
  return Object.freeze({
    imageUri: await u.oss.getPrivateFileUrl(derivativePath, { expiresInSeconds: 300 }),
    plan,
    derivative: true,
    derivativePath,
  });
}
