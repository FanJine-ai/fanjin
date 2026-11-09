import { Readable } from "node:stream";
import isPathInside from "is-path-inside";
import getPath from "@/utils/getPath";
import { constants as fsConstants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveObjectStorageConfiguration } from "@/lib/objectStorageConfig";
import {
  createRemoteObjectStorageAdapter,
  normalizeObjectKey,
  ObjectStorageUpstreamError,
  type ObjectStorageConditionalDeleteReceipt,
  type ObjectStorageWriteReceipt,
} from "@/lib/objectStorage";
import { isRecoveryOnlyMode } from "@/lib/recoveryOnlyMode";
import {
  ContainedLocalFileError,
  resolveContainedExistingLocalPath,
  writeNewContainedLocalFile,
} from "@/lib/containedLocalFile";

// 规范化路径：去除前导斜杠，并将路径分隔符统一转换为系统分隔符
function normalizeUserPath(userPath: string): string {
  const trimmedPath = normalizeObjectKey(userPath);
  // 将所有 / 替换为系统路径分隔符（path.sep）
  // 这样在 Windows 上会转为 \，在 Unix 上保持 /
  return trimmedPath.split("/").join(path.sep);
}

// 校验路径
function resolveSafeLocalPath(userPath: string, rootDir: string): string {
  const safePath = normalizeUserPath(userPath);
  const absPath = path.join(rootDir, safePath);
  if (!isPathInside(absPath, rootDir)) {
    throw new Error(`${userPath} 不在 OSS 根目录内`);
  }
  return absPath;
}

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const FILE_UPLOAD_TIMEOUT_MS = 15 * 60_000;

function mimeTypeForPath(userPath: string): string {
  return MIME_TYPES[path.extname(userPath).toLowerCase()] || "application/octet-stream";
}

class OSS {
  private rootDir: string;
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.rootDir = getPath("oss");
  }

  /**
   * 等待根目录初始化完成。用于保证所有文件操作在目录已创建后执行。
   * @private
   */
  private async ensureInit() {
    if (isRecoveryOnlyMode()) {
      let stat;
      try {
        stat = await fs.lstat(this.rootDir);
      } catch {
        throw new ObjectStorageUpstreamError(
          "RECOVERY_ONLY_OSS_ROOT_MISSING",
          503,
        );
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new ObjectStorageUpstreamError(
          "RECOVERY_ONLY_OSS_ROOT_INVALID",
          503,
        );
      }
      return;
    }
    this.initPromise ||= fs.mkdir(this.rootDir, { recursive: true }).then(() => {});
    await this.initPromise;
  }

  private remoteAdapter() {
    const configuration = resolveObjectStorageConfiguration();
    if (isRecoveryOnlyMode() && configuration.provider !== "local") {
      throw new ObjectStorageUpstreamError(
        "RECOVERY_ONLY_REMOTE_OBJECT_STORAGE_BLOCKED",
        503,
      );
    }
    return configuration.provider === "local"
      ? null
      : createRemoteObjectStorageAdapter(configuration);
  }

  private recoveryPathError(error: unknown): never {
    if (error instanceof ContainedLocalFileError) {
      throw new ObjectStorageUpstreamError(
        "RECOVERY_ONLY_OSS_PATH_REJECTED",
        503,
      );
    }
    throw error;
  }

  /**
   * 获取指定相对路径文件的访问 URL。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns 文件的 http 链接（本地服务地址）
   */
  async getFileUrl(userRelPath: string, prefix?: string): Promise<string> {
    if (!prefix) prefix = "oss";
    const remote = this.remoteAdapter();
    if (remote && prefix === "oss") return remote.getUrl(normalizeObjectKey(userRelPath));
    await this.ensureInit();
    const safePath = normalizeUserPath(userRelPath);
    // URL 始终使用 /，所以这里需要将系统分隔符转回 /
    let url = `/${prefix}/`;
    if (process.env.ossURL && process.env.ossURL !== "") url = process.env.ossURL + `/${prefix}/`;
    if (process.env.NODE_ENV == "dev") {
      const port = process.env.FANJIN_APP_PORT || process.env.PORT || "10588";
      url = `http://localhost:${port}/${prefix}/`;
    }
    return `${url}${safePath.split(path.sep).join("/")}`;
  }

  /**
   * Produce a private, short-lived URL for an external processor. Local files
   * and stable CDN delivery are deliberately rejected: the provider may only
   * read the authoritative object through a signed remote-storage URL.
   */
  async getPrivateFileUrl(
    userRelPath: string,
    options: { expiresInSeconds?: number; versionId?: string | null } = {},
  ): Promise<string> {
    const remote = this.remoteAdapter();
    if (!remote?.getSignedUrl) {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_PRIVATE_DELIVERY_UNAVAILABLE",
        503,
      );
    }
    return remote.getSignedUrl(normalizeObjectKey(userRelPath), {
      expiresInSeconds: options.expiresInSeconds ?? 300,
      versionId: options.versionId ?? null,
    });
  }

  /**
   * 读取指定路径的文件内容为 Buffer。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns 文件内容的 Buffer
   * @throws 路径不在 OSS 根目录内、文件不存在等错误
   */
  /** Metadata/stream reads keep large CLI downloads out of the API heap. */
  async getFileMetadata(userRelPath: string): Promise<{ sizeBytes: number; mimeType: string } | null> {
    const key = normalizeObjectKey(userRelPath), remote = this.remoteAdapter();
    if (remote) {
      const object = await remote.inspectGeneration(key);
      return object.exists && Number.isSafeInteger(object.size) && Number(object.size) >= 0
        ? { sizeBytes: Number(object.size), mimeType: object.contentType || mimeTypeForPath(key) } : null;
    }
    await this.ensureInit();
    try {
      const file = resolveContainedExistingLocalPath({ rootDirectory: this.rootDir, relativePath: key, kind: "file" });
      const stat = await fs.stat(file);
      return { sizeBytes: stat.size, mimeType: mimeTypeForPath(key) };
    } catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
  }

  async getFileStream(userRelPath: string): Promise<{ stream: Readable; sizeBytes: number; mimeType: string }> {
    const key = normalizeObjectKey(userRelPath), remote = this.remoteAdapter();
    if (remote) {
      if (!remote.getSignedUrl) throw new ObjectStorageUpstreamError("OBJECT_STORAGE_PRIVATE_DELIVERY_UNAVAILABLE", 503);
      const url = await remote.getSignedUrl(key, { expiresInSeconds: 300 });
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15 * 60_000);
      try {
        const response = await fetch(url, { signal: controller.signal, redirect: "error" });
        const sizeBytes = Number(response.headers.get("content-length"));
        if (!response.ok || !response.body || !response.headers.has("content-length") || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
          await response.body?.cancel(); throw new ObjectStorageUpstreamError("OBJECT_STORAGE_DOWNLOAD_FAILED", 502);
        }
        const stream = Readable.fromWeb(response.body as any);
        stream.once("close", () => { clearTimeout(timer); controller.abort(); });
        return { stream, sizeBytes, mimeType: response.headers.get("content-type") || mimeTypeForPath(key) };
      } catch (error) { clearTimeout(timer); controller.abort(); throw error; }
    }
    await this.ensureInit();
    const file = resolveContainedExistingLocalPath({ rootDirectory: this.rootDir, relativePath: key, kind: "file" });
    const stat = await fs.stat(file);
    return { stream: createReadStream(file), sizeBytes: stat.size, mimeType: mimeTypeForPath(key) };
  }

  async getFile(userRelPath: string): Promise<Buffer> {
    const remote = this.remoteAdapter();
    if (remote) return remote.get(normalizeObjectKey(userRelPath));
    await this.ensureInit();
    if (isRecoveryOnlyMode()) {
      try {
        return await fs.readFile(resolveContainedExistingLocalPath({
          rootDirectory: this.rootDir,
          relativePath: userRelPath,
          kind: "file",
        }));
      } catch (error) {
        return this.recoveryPathError(error);
      }
    }
    return fs.readFile(resolveSafeLocalPath(userRelPath, this.rootDir));
  }

  /**
   * 读取图片文件并转换为 base64 编码的 Data URL。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns base64 编码的 Data URL (例如: data:image/png;base64,iVBORw0KGgo...)
   * @throws 路径不在 OSS 根目录内、文件不存在、不是图片文件等错误
   */
  async getImageBase64(userRelPath: string): Promise<string> {
    // 获取文件扩展名并确定 MIME 类型
    const ext = path.extname(userRelPath).toLowerCase();
    const mimeType = MIME_TYPES[ext];
    if (!mimeType) {
      throw new Error(`不支持的图片格式: ${ext}。支持的格式: ${Object.keys(MIME_TYPES).join(", ")}`);
    }

    // 读取文件并转换为 base64
    const data = await this.getFile(userRelPath);
    const base64 = data.toString("base64");
    // 返回完整的 Data URL
    return `data:${mimeType};base64,${base64}`;
  }
  /**
   * 删除指定路径的文件。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @throws 路径不在 OSS 根目录内、文件不存在等错误
   */
  async deleteFile(userRelPath: string): Promise<void> {
    const remote = this.remoteAdapter();
    if (remote) return remote.delete(normalizeObjectKey(userRelPath));
    await this.ensureInit();
    if (isRecoveryOnlyMode()) {
      try {
        await fs.unlink(resolveContainedExistingLocalPath({
          rootDirectory: this.rootDir,
          relativePath: userRelPath,
          kind: "file",
        }));
        return;
      } catch (error) {
        return this.recoveryPathError(error);
      }
    }
    await fs.unlink(resolveSafeLocalPath(userRelPath, this.rootDir));
  }

  /**
   * 删除指定路径的文件夹及其所有内容。
   * @param userRelPath 用户传入的相对文件夹路径（使用 / 作为分隔符）
   * @throws 路径不在 OSS 根目录内、文件夹不存在、目标是文件而非文件夹等错误
   */
  async deleteDirectory(userRelPath: string): Promise<void> {
    const remote = this.remoteAdapter();
    if (remote) return remote.deletePrefix(normalizeObjectKey(userRelPath.replace(/\/+$/, "")));
    await this.ensureInit();
    if (isRecoveryOnlyMode()) {
      try {
        await fs.rm(resolveContainedExistingLocalPath({
          rootDirectory: this.rootDir,
          relativePath: userRelPath.replace(/\/+$/, ""),
          kind: "directory",
        }), { recursive: true, force: true });
        return;
      } catch (error) {
        return this.recoveryPathError(error);
      }
    }
    const absPath = resolveSafeLocalPath(userRelPath, this.rootDir);
    const stat = await fs.stat(absPath);
    if (!stat.isDirectory()) {
      throw new Error(`${userRelPath} 不是文件夹`);
    }
    await fs.rm(absPath, { recursive: true, force: true });
  }

  /**
   * 将数据写入指定路径的新文件或覆盖已有文件。
   * 写入前自动创建所需的父文件夹。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @param data 要写入的数据，可以为 Buffer 或字符串
   * @throws 路径不在 OSS 根目录内等错误
   */
  async writeFile(
    userRelPath: string,
    data: Buffer | string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ObjectStorageWriteReceipt | null> {
    options.signal?.throwIfAborted();
    // 如果 data 是 string，则视为 base64 编码，先解码再写入
    // 自动去除可能存在的 Data URL 前缀（如 "data:image/png;base64,"）
    const buffer = typeof data === "string" ? Buffer.from(data.replace(/^data:[^;]+;base64,/, ""), "base64") : data;
    const remote = this.remoteAdapter();
    if (remote) {
      return remote.put(
        normalizeObjectKey(userRelPath),
        buffer,
        mimeTypeForPath(userRelPath),
        options,
      );
    }
    await this.ensureInit();
    if (isRecoveryOnlyMode()) {
      try {
        await writeNewContainedLocalFile({
          rootDirectory: this.rootDir,
          relativePath: userRelPath,
          data: buffer,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        return null;
      } catch (error) {
        return this.recoveryPathError(error);
      }
    }
    const absPath = resolveSafeLocalPath(userRelPath, this.rootDir);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, buffer, { signal: options.signal });
    options.signal?.throwIfAborted();
    return null;
  }

  /**
   * Publish a new local file without first materialising it as a Node Buffer.
   * This is reserved for large, already-finalised media outputs. Remote object
   * storage receives a signed streaming PUT; local storage uses an exclusive
   * kernel copy so a caller cannot accidentally replace an existing object.
   */
  async writeNewFileFromPath(
    userRelPath: string,
    sourcePath: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    const sourceStat = await fs.lstat(sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size < 1) {
      throw new Error("OBJECT_STORAGE_SOURCE_FILE_INVALID");
    }
    const key = normalizeObjectKey(userRelPath);
    const remote = this.remoteAdapter();
    if (!remote) {
      await this.ensureInit();
      if (isRecoveryOnlyMode()) {
        throw new ObjectStorageUpstreamError("RECOVERY_ONLY_OSS_WRITE_BLOCKED", 503);
      }
      const destinationPath = resolveSafeLocalPath(key, this.rootDir);
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
      options.signal?.throwIfAborted();
      return;
    }

    const contentType = mimeTypeForPath(key);
    const signed = await remote.createUploadUrl(key, {
      expiresInSeconds: 900,
      contentLength: sourceStat.size,
      contentType,
    });
    const timeoutSignal = AbortSignal.timeout(FILE_UPLOAD_TIMEOUT_MS);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    try {
      const response = await fetch(signed.url, {
        method: signed.method,
        headers: {
          "content-length": String(sourceStat.size),
          "content-type": contentType,
        },
        body: createReadStream(sourcePath, { signal }) as unknown as BodyInit,
        redirect: "manual",
        signal,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      await response.body?.cancel();
      if (response.status < 200 || response.status >= 300 || response.redirected) {
        throw new ObjectStorageUpstreamError("OBJECT_STORAGE_FILE_UPLOAD_FAILED", 502);
      }
    } catch (error) {
      if (error instanceof ObjectStorageUpstreamError) throw error;
      if (options.signal?.aborted) options.signal.throwIfAborted();
      // Do not propagate fetch errors containing a credential-bearing signed URL.
      throw new ObjectStorageUpstreamError("OBJECT_STORAGE_FILE_UPLOAD_FAILED", 502);
    }
  }

  /**
   * Compensate a completed remote PUT without touching any replacement
   * generation that may now exist at the same logical key.
   */
  async deleteWriteReceipt(
    receipt: ObjectStorageWriteReceipt,
    options: { signal?: AbortSignal } = {},
  ): Promise<ObjectStorageConditionalDeleteReceipt> {
    const configuration = resolveObjectStorageConfiguration();
    const remote = configuration.provider === "local"
      ? null
      : createRemoteObjectStorageAdapter(configuration);
    const key = normalizeObjectKey(receipt.key);
    if (
      !remote
      || receipt.provider !== configuration.provider
      || receipt.bucket !== configuration.bucket
      || receipt.region !== configuration.region
      || receipt.endpoint !== configuration.endpoint
      || receipt.keyPrefix !== configuration.keyPrefix
      || receipt.forcePathStyle !== configuration.forcePathStyle
      || !receipt.versionId
      || !receipt.etag
    ) {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_WRITE_RECEIPT_NOT_COMPENSATABLE",
        503,
      );
    }
    return remote.deleteGenerationIfMatch(key, {
      etag: receipt.etag,
      versionId: receipt.versionId,
      deleteMarker: false,
      signal: options.signal,
    });
  }

  async compensateFailedWrite(
    userRelPath: string,
    receipt: ObjectStorageWriteReceipt | null,
  ): Promise<void> {
    const key = normalizeObjectKey(userRelPath);
    if (receipt) {
      if (normalizeObjectKey(receipt.key) !== key) {
        throw new ObjectStorageUpstreamError(
          "OBJECT_STORAGE_WRITE_RECEIPT_KEY_MISMATCH",
          409,
        );
      }
      await this.deleteWriteReceipt(receipt);
      return;
    }
    if (resolveObjectStorageConfiguration().provider !== "local") {
      throw new ObjectStorageUpstreamError(
        "OBJECT_STORAGE_WRITE_RECEIPT_MISSING",
        503,
      );
    }
    await this.deleteFile(key);
  }

  /**
   * 检查指定路径文件是否存在。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns 文件存在返回 true，否则 false
   */
  async fileExists(userRelPath: string): Promise<boolean> {
    const remote = this.remoteAdapter();
    if (remote) return remote.exists(normalizeObjectKey(userRelPath));
    await this.ensureInit();
    try {
      if (isRecoveryOnlyMode()) {
        resolveContainedExistingLocalPath({
          rootDirectory: this.rootDir,
          relativePath: userRelPath,
          kind: "file",
        });
        return true;
      }
      const stat = await fs.stat(resolveSafeLocalPath(userRelPath, this.rootDir));
      return stat.isFile();
    } catch {
      return false;
    }
  }

  /**
   * 获取图片的缩略图 URL（最长边不超过 512px，等比缩放）。
   * 缩略图保存在原路径同目录下的 smallImage 子文件夹中。
   * 若缩略图已存在则直接返回其 URL；若不存在则同步生成并保存后返回缩略图 URL，
   * 生成失败时返回原图 URL。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns 缩略图 URL（已存在或生成成功）或原图 URL（生成失败时）
   */
  async getSmallImageUrl(userRelPath: string): Promise<string> {
    const remote = this.remoteAdapter();
    if (remote) return remote.getUrl(normalizeObjectKey(userRelPath));
    // 构造缩略图相对路径：在原路径的目录层级前插入 smallImage 目录
    // 例如：123/abc.jpg => smallImage/123/abc.jpg
    // const smallImageRelPath = `smallImage/${userRelPath.replace(/^[/\\]+/, "")}`;

    // if (await this.fileExists(smallImageRelPath)) {
    //   return this.getFileUrl(smallImageRelPath);
    // }

    // // 缩略图不存在：同步生成，生成失败则返回原图 URL
    // const originalUrl = await this.getFileUrl(userRelPath);

    // try {
    //   await this.ensureInit();
    //   const srcAbsPath = resolveSafeLocalPath(userRelPath, this.rootDir);
    //   const dstAbsPath = resolveSafeLocalPath(smallImageRelPath, this.rootDir);
    //   await fs.mkdir(path.dirname(dstAbsPath), { recursive: true });
    //   await sharp(srcAbsPath)
    //     .resize(512, 512, { fit: "inside", withoutEnlargement: true })
    //     .toFile(dstAbsPath);
    //   console.info(`[${dstAbsPath}]小图写入成功`);
    return (await this.getFileUrl(userRelPath)) + "?size=20";
    // } catch (e) {
    //   // 生成失败返回原图
    //   console.warn("[OSS] 生成缩略图失败:", e);
    //   return originalUrl;
    // }
  }
}

export default new OSS();
