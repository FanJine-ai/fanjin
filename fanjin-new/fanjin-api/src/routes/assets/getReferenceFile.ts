import { assetLibrarySchemaAvailable, assertAssetLibraryPermission } from "@/lib/accountWorkspaceAssetLibrary";
import path from "node:path";
import express from "express";
import { z } from "zod";
import { requireInferredProjectPermission } from "@/middleware/projectAccess";
import u from "@/utils";
import { isReferenceAssetDeliveryPath } from "@/lib/referenceAssetDeliveryPath";
import { db } from "@/utils/db";

const router = express.Router();

const querySchema = z.object({
  id: z.coerce.number().int().positive(),
  disposition: z.enum(["inline", "attachment"]).default("inline"),
}).strict();

const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
};

function privateHeaders(res: express.Response) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function safeOriginalFileName(value: unknown, filePath: string): string {
  const normalized = String(value || "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .split(/[\\/]/)
    .pop()
    ?.trim();
  const fallback = `fanjin-asset${path.extname(filePath).toLowerCase() || ".bin"}`;
  return (normalized || fallback).slice(0, 255);
}

function contentDisposition(disposition: "inline" | "attachment", fileName: string): string {
  const extension = path.extname(fileName).replace(/[^.A-Za-z0-9_-]/g, "").slice(0, 20);
  const asciiFallback = `fanjin-asset${extension || ".bin"}`;
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function parseSingleRange(value: string, size: number): { start: number; end: number } | null | "invalid" {
  if (!value) return null;
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2]) || size < 1) return "invalid";
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
      return "invalid";
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

router.use((_req, res, next) => {
  privateHeaders(res);
  next();
});

router.get(
  "/",
  requireInferredProjectPermission("project:read"),
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return res.status(404).send({ message: "资源不存在" });

    const workspaceId = String((req as any).auth?.workspaceId || "").trim();
    const asset = await db("o_assets as asset")
      .innerJoin("o_project as project", "asset.projectId", "project.id")
      .innerJoin("o_image as image", function () {
        this.on("asset.imageId", "=", "image.id")
          .andOn("image.assetsId", "=", "asset.id");
      })
      .where("asset.id", parsed.data.id)
      .andWhere("asset.deletionState", "active")
      .andWhere("image.deletionState", "active")
      .andWhere("project.deletionState", "active")
      .andWhere("project.workspaceId", workspaceId)
      .select(
        "asset.id",
        "asset.name",
        "asset.type",
        "asset.projectId",
        "image.filePath",
      )
      .first();

    const filePath = String(asset?.filePath || "").replace(/\\/g, "/");
    if (!asset || !isReferenceAssetDeliveryPath({
      filePath,
      projectId: asset.projectId,
      workspaceId,
    })) {
      return res.status(404).send({ message: "资源不存在" });
    }

    try {
      if (await assetLibrarySchemaAvailable(db)) await assertAssetLibraryPermission({ database: db, workspaceId,
        actorUserId: Number((req as any).auth?.user?.id || 0), assetId: asset.id, permission: "view" });
      const body = await u.oss.getFile(filePath);
      const fileName = safeOriginalFileName(asset.name, filePath);
      const range = parseSingleRange(String(req.header("range") || "").trim(), body.length);
      if (range === "invalid") {
        return res.status(416).setHeader("Content-Range", `bytes */${body.length}`).end();
      }

      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] || "application/octet-stream");
      res.setHeader("Content-Disposition", contentDisposition(parsed.data.disposition, fileName));
      if (range) {
        res.status(206);
        res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${body.length}`);
        res.setHeader("Content-Length", String(range.end - range.start + 1));
        return req.method === "HEAD" ? res.end() : res.send(body.subarray(range.start, range.end + 1));
      }
      res.setHeader("Content-Length", String(body.length));
      return req.method === "HEAD" ? res.end() : res.status(200).send(body);
    } catch (error) {
      console.error("Reference asset delivery failed", error);
      return res.status(404).send({ message: "资源不存在" });
    }
  },
);

export default router;
