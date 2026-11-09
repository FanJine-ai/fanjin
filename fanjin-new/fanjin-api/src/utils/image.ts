import fs from "node:fs/promises";
import fss from "fs";
import path from "node:path";
import sharp from "sharp";
import type { FitEnum } from "sharp";
import {
  logRuntimeFilesystemFailure,
  logRuntimePath,
} from "@/lib/candidateRuntimeLogProjection";

/**
 * 图片缩放选项
 */
export interface ResizeOptions {
  /** 最大宽度（默认 256 */
  width?: number;
  /** 最大高度（默认 256 */
  height?: number;
  /** 缩放策略，默认等比缩放不超出边界 */
  fit?: keyof FitEnum;
  /** 是否禁止放大（默认 true） */
  withoutEnlargement?: boolean;
}

const defaultResizeOptions: Required<ResizeOptions> = {
  width: 256,
  height: 256,
  fit: "inside",
  withoutEnlargement: true,
};

/**
 * 将图片缩放后写入目标路径（自动创建父目录）。
 * @param srcPath 源图片绝对路径
 * @param dstPath 目标图片绝对路径
 * @param opts 缩放选项
 */
export async function resizeImage(srcPath: string, dstPath: string, opts?: ResizeOptions): Promise<void> {
  const { width, height, fit, withoutEnlargement }: Required<ResizeOptions> = { ...defaultResizeOptions, ...opts };
  await fs.mkdir(path.dirname(dstPath), { recursive: true });
  await sharp(srcPath).resize(width, height, { fit, withoutEnlargement }).toFile(dstPath);
}

/**
 * 缩略图自定义尺寸选项
 */
export type ThumbnailSize =
  | { type: "dimensions"; width: number; height: number }
  | { type: "percentage"; value: number };

export interface ThumbnailDependencies {
  readMetadata?: (sourcePath: string) => Promise<{
    width?: number;
    height?: number;
  }>;
  resize?: typeof resizeImage;
}

const thumbnailFlights = new Map<string, Promise<string | null>>();

function thumbnailFlightKey(
  originalPath: string,
  thumbnailPath: string,
  size?: ThumbnailSize,
): string {
  return JSON.stringify({
    originalPath: path.resolve(originalPath),
    thumbnailPath: path.resolve(thumbnailPath),
    size: size ?? null,
  });
}

async function isSupportedRasterImage(sourcePath: string): Promise<boolean> {
  const extension = path.extname(sourcePath).toLowerCase();
  const handle = await fs.open(sourcePath, "r");
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const bytes = header.subarray(0, bytesRead);
    if (
      (extension === ".jpg" || extension === ".jpeg")
      && bytes.length >= 3
      && bytes[0] === 0xff
      && bytes[1] === 0xd8
      && bytes[2] === 0xff
    ) return true;
    if (
      extension === ".png"
      && bytes.length >= 8
      && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) return true;
    if (
      extension === ".gif"
      && bytes.length >= 6
      && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
    ) return true;
    if (
      extension === ".webp"
      && bytes.length >= 12
      && bytes.subarray(0, 4).toString("ascii") === "RIFF"
      && bytes.subarray(8, 12).toString("ascii") === "WEBP"
    ) return true;
    if (
      extension === ".bmp"
      && bytes.length >= 2
      && bytes.subarray(0, 2).toString("ascii") === "BM"
    ) return true;
    if (
      [".tif", ".tiff"].includes(extension)
      && bytes.length >= 4
      && (
        bytes.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]))
        || bytes.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))
      )
    ) return true;
    if (
      extension === ".ico"
      && bytes.length >= 4
      && bytes.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0x01, 0x00]))
    ) return true;
    return false;
  } finally {
    await handle.close();
  }
}

async function generateThumbnail(
  originalPath: string,
  thumbnailPath: string,
  size?: ThumbnailSize,
  dependencies: ThumbnailDependencies = {},
): Promise<string | null> {
  // A caller-controlled extension is not enough to enter Sharp. Confirm a
  // supported raster signature first, including on cache hits, so videos and
  // arbitrary files can never manufacture or reuse thumbnail cache entries.
  if (!fss.existsSync(originalPath)) return null;
  try {
    if (!await isSupportedRasterImage(originalPath)) {
      logRuntimeFilesystemFailure(
        "[image] 已拒绝非图片缩略图源",
        new Error("UNSUPPORTED_THUMBNAIL_MEDIA_TYPE"),
      );
      return null;
    }
  } catch (error) {
    logRuntimeFilesystemFailure("[image] 缩略图媒体类型检查失败", error);
    return null;
  }
  if (fss.existsSync(thumbnailPath)) return thumbnailPath;

  const resize = dependencies.resize ?? resizeImage;
  const readMetadata = dependencies.readMetadata
    ?? ((sourcePath: string) => sharp(sourcePath).metadata());
  try {
    if (size?.type === "percentage") {
      // 百分比缩放：先获取原图尺寸，再等比计算目标尺寸
      const meta = await readMetadata(originalPath);
      if (!meta.width || !meta.height) {
        logRuntimePath("[image] 无法获取原图尺寸:", originalPath, {
          level: "warn",
        });
        return null;
      }
      const pct = size.value / 100;
      const w = Math.round(meta.width * pct);
      const h = Math.round(meta.height * pct);
      await resize(originalPath, thumbnailPath, { width: w, height: h });
    } else if (size?.type === "dimensions") {
      // 固定宽高：等比缩放适配到指定边界
      await resize(originalPath, thumbnailPath, {
        width: size.width,
        height: size.height,
      });
    } else {
      // 默认 256x256 inside
      await resize(originalPath, thumbnailPath);
    }
    logRuntimePath("[image] 小图生成成功:", thumbnailPath);
    return thumbnailPath;
  } catch (e) {
    logRuntimeFilesystemFailure("[image] 生成缩略图失败:", e);
    return null;
  }
}

/**
 * 生成缩略图。
 * - 若缩略图已存在，直接返回其路径。
 * - 若不存在，生成后返回目标路径；生成失败返回 null。
 *
 * @param originalPath 原图绝对路径
 * @param thumbnailPath 缩略图绝对路径
 * @param size 可选的自定义尺寸：固定宽高 或 百分比（默认 256x256 inside）
 * @returns 缩略图路径，失败返回 null
 */
export async function ensureThumbnail(
  originalPath: string,
  thumbnailPath: string,
  size?: ThumbnailSize,
  dependencies: ThumbnailDependencies = {},
): Promise<string | null> {
  const key = thumbnailFlightKey(originalPath, thumbnailPath, size);
  const active = thumbnailFlights.get(key);
  if (active) return active;
  const flight = generateThumbnail(
    originalPath,
    thumbnailPath,
    size,
    dependencies,
  );
  thumbnailFlights.set(key, flight);
  try {
    return await flight;
  } finally {
    if (thumbnailFlights.get(key) === flight) thumbnailFlights.delete(key);
  }
}
