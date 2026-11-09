import express from "express";
import { validatePublicMediaUrl } from "@/lib/videoFulfillment/userEnhance";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";
import u from "@/utils";
import { db } from "@/utils/db";

const router = express.Router({ mergeParams: true });
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 5;

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
};

function parseMetadata(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function attachmentFileName(metadata: unknown, mimeType: string): string {
  const raw = String(parseMetadata(metadata).fileName || "fanjin-media").trim();
  const safe = raw
    .replace(/[\\/\r\n";]/g, "-")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
    .slice(0, 120) || "fanjin-media";
  const extension = MIME_EXTENSIONS[mimeType] || "";
  return extension && !safe.toLowerCase().endsWith(extension) ? `${safe}${extension}` : safe;
}

async function fetchMedia(rawUrl: string, signal: AbortSignal): Promise<Response> {
  let url = await validatePublicMediaUrl(rawUrl, "source");
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(url, { redirect: "manual", signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location || redirects === MAX_REDIRECTS) throw new Error("MEDIA_REDIRECT_INVALID");
    url = await validatePublicMediaUrl(new URL(location, url).toString(), "source");
  }
  throw new Error("MEDIA_REDIRECT_INVALID");
}

async function readBoundedBody(response: Response): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DOWNLOAD_BYTES) {
    throw new Error("MEDIA_TOO_LARGE");
  }
  if (!response.body) throw new Error("MEDIA_BODY_MISSING");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DOWNLOAD_BYTES) throw new Error("MEDIA_TOO_LARGE");
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

router.get(
  "/",
  requireActiveWorkspacePermission("project:read"),
  async (req, res) => {
    const workspaceId = String((req as any).auth?.workspaceId || "").trim();
    const asset = await db("o_media_asset")
      // Keep download visibility identical to the authoritative library list:
      // only an explicitly active row is readable. Legacy NULL must fail
      // closed too, otherwise a known UUID could bypass a soft-delete tombstone.
      .where({ id: req.params.assetId, workspaceId, deletionState: "active" })
      .first();
    if (!asset) return res.status(404).send({ message: "媒体不存在或无权访问" });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const storageKey = typeof asset.storageKey === "string"
        ? asset.storageKey.trim()
        : "";
      if (storageKey) {
        const body = await u.oss.getFile(storageKey);
        if (body.length > MAX_DOWNLOAD_BYTES) throw new Error("MEDIA_TOO_LARGE");
        const mimeType = String(asset.mimeType || "application/octet-stream")
          .split(";")[0]
          .trim()
          .toLowerCase();
        const fileName = attachmentFileName(asset.metadata, mimeType);
        res.setHeader("Content-Type", mimeType);
        res.setHeader("Content-Length", String(body.length));
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
        return res.status(200).send(body);
      }

      // Compatibility fallback for legacy rows only. Newly generated media
      // always carries storageKey and is read directly from Fanjin storage.
      const upstream = await fetchMedia(String(asset.url || ""), controller.signal);
      if (!upstream.ok) return res.status(502).send({ message: "媒体源暂时不可用" });
      const body = await readBoundedBody(upstream);
      const mimeType = String(
        upstream.headers.get("content-type") || asset.mimeType || "application/octet-stream",
      ).split(";")[0].trim().toLowerCase();
      const fileName = attachmentFileName(asset.metadata, mimeType);
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Content-Length", String(body.length));
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      return res.status(200).send(body);
    } catch {
      if (!res.headersSent) return res.status(502).send({ message: "媒体下载失败" });
      return res.end();
    } finally {
      clearTimeout(timeout);
    }
  },
);

export default router;
