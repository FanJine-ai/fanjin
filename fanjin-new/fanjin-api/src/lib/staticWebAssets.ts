import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { randomUUID } from "node:crypto";
import express from "express";
import type { RequestHandler } from "express";

const COMPRESSIBLE_WEB_ASSET = /\.(?:html|js|css|json|svg|ico)$/i;

export interface WebPrecompressionResult {
  compressed: number;
  current: number;
}

function gzip(content: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zlib.gzip(content, { level: 9 }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

async function gzipAssetIfStale(filePath: string): Promise<"compressed" | "current"> {
  const gzipPath = `${filePath}.gz`;
  const sourceStat = await fs.promises.stat(filePath);
  const gzipStat = await fs.promises.stat(gzipPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (gzipStat && gzipStat.mtimeMs >= sourceStat.mtimeMs) return "current";

  const compressed = await gzip(await fs.promises.readFile(filePath));
  const temporaryPath = `${gzipPath}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temporaryPath, compressed);
    await fs.promises.rename(temporaryPath, gzipPath);
  } finally {
    await fs.promises.rm(temporaryPath, { force: true });
  }
  return "compressed";
}

/** Precompress immutable web release assets before the HTTP listener accepts requests. */
export async function precompressWebAssets(webDir: string): Promise<WebPrecompressionResult> {
  const result: WebPrecompressionResult = { compressed: 0, current: 0 };
  const pendingDirectories = [path.resolve(webDir)];

  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop()!;
    const entries = await fs.promises.readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(entryPath);
      } else if (entry.isFile() && COMPRESSIBLE_WEB_ASSET.test(entry.name)) {
        const status = await gzipAssetIfStale(entryPath);
        result[status] += 1;
      }
    }
  }

  return result;
}

function acceptsGzip(header: string | string[] | undefined): boolean {
  let wildcard: boolean | null = null;
  const entries = String(header || "")
    .split(",")
    .map((item) => item.trim().toLowerCase());
  for (const item of entries) {
    const [encoding, ...parameters] = item.split(";").map((part) => part.trim());
    const quality = parameters.find((parameter) => parameter.startsWith("q="));
    const accepted = quality === undefined || Number(quality.slice(2)) > 0;
    if (encoding === "gzip") return accepted;
    if (encoding === "*") wildcard = accepted;
  }
  return wildcard ?? false;
}

function contentType(filePath: string): string | null {
  const map: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
  };
  return map[path.extname(filePath).toLowerCase()] || null;
}

function resolveWebAsset(webDir: string, requestPath: string): string | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(requestPath === "/" ? "/index.html" : requestPath);
  } catch {
    return null;
  }

  const root = path.resolve(webDir);
  const filePath = path.resolve(root, decodedPath.replace(/^[/\\]+/, ""));
  const relativePath = path.relative(root, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
  return filePath;
}

/** Serve only gzip files produced during build/startup; never compress on a request. */
export function precompressedStaticMiddleware(webDir: string): RequestHandler {
  const root = path.resolve(webDir);
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (!acceptsGzip(req.headers["accept-encoding"])) return next();

    const filePath = resolveWebAsset(webDir, req.path);
    if (!filePath || !COMPRESSIBLE_WEB_ASSET.test(filePath) || !fs.existsSync(filePath)) return next();
    // HTML goes through the no-store handler below. Express sendFile overrides
    // its per-file etag option with the app-wide setting, so do not use it here.
    if (path.extname(filePath).toLowerCase() === ".html") return next();
    const gzipPath = `${filePath}.gz`;
    if (!fs.existsSync(gzipPath)) return next();

    const type = contentType(filePath);
    if (type) res.setHeader("Content-Type", type);
    res.setHeader("Content-Encoding", "gzip");
    res.vary("Accept-Encoding");
    res.setHeader("Cache-Control", "public, max-age=0");
    // Resolve relative to the public bundle, so hidden checkout parent directories
    // do not make public assets inaccessible. Dotfiles within the bundle stay private.
    return res.sendFile(path.relative(root, gzipPath), { root, acceptRanges: false }, (error) => {
      if (!error) return;
      if (!res.headersSent) {
        res.removeHeader("Content-Encoding");
        res.removeHeader("Content-Type");
        res.removeHeader("Cache-Control");
      }
      return next(error);
    });
  };
}

/**
 * Serve the public web bundle with byte ranges enabled. The landing page
 * scrubs its hero MP4 by setting `currentTime`, so browsers need 206 responses
 * instead of downloading the entire video again for each seek.
 */
export function webStaticMiddleware(webDir: string): RequestHandler {
  const assets = express.static(webDir, { acceptRanges: true });
  // Reproducible archives normalize mtimes. Equal-size HTML from different
  // releases must not share Express's size/mtime validator and reuse old chunks.
  const html = express.static(webDir, {
    acceptRanges: true,
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
  });
  return (req, res, next) => {
    const filePath = resolveWebAsset(webDir, req.path);
    return filePath && path.extname(filePath).toLowerCase() === ".html"
      ? html(req, res, next)
      : assets(req, res, next);
  };
}
