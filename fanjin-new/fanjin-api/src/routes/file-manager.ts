import express from "express";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { db } from "@/utils/db";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { AssetLibraryError } from "@/lib/accountWorkspaceAssetLibrary";
import { importGenerationHistory } from "@/lib/generationHistoryImport";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";
import { resolveObjectStorageConfiguration } from "@/lib/objectStorageConfig";
import { listManagedFiles, managedFileVersion, updateFile, listFileFolders, writeFileFolder, placeProjectFile,
  setGenerationHistoryHidden, type FileManagerContext } from "@/lib/assetFileManager";

const router = express.Router();
router.use(requireActiveWorkspacePermission("project:read"));
router.use((_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); });

const positive = z.number().int().positive();
const filename = z.string().trim().min(1).max(200);
function context(req: express.Request): FileManagerContext {
  return { database: db, workspaceId: String((req as any).auth?.workspaceId || ""),
    actorUserId: Number((req as any).auth?.user?.id || 0), role: (req as any).auth?.user?.role };
}
function endpoint<T>(schema: z.ZodType<T>, run: (ctx: FileManagerContext, input: T) => Promise<unknown>) {
  return async (req: express.Request, res: express.Response) => {
    try { return res.send(success(await run(context(req), schema.parse(req.body)))); }
    catch (error) {
      if (error instanceof z.ZodError) return res.status(400).send({ message: "输入有误，请检查后重试" });
      if (error instanceof AssetLibraryError) return res.status(error.status).send({ code: error.code, message: error.message });
      throw error;
    }
  };
}
router.post("/list", endpoint(z.object({ projectId: positive.optional(), folderId: z.string().uuid().nullable().optional(),
  trash: z.boolean().optional(), source: z.enum(["uploaded", "generated"]).optional(),
  type: z.enum(["image", "video", "audio", "document", "role", "scene", "tool"]).optional(), keyword: z.string().max(200).optional(),
  usage: z.enum(["role", "scene", "tool", "action", "audio", "camera", "style", "composition", "other", "uncategorized"]).optional(),
  page: positive.default(1), limit: z.number().int().min(1).max(60).default(36) }).strict(), listManagedFiles));
router.post("/update", endpoint(z.object({ assetId: positive, expectedRevision: positive, name: filename.optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(), action: z.enum(["trash", "restore"]).optional() }).strict(), updateFile));
router.post("/folders", endpoint(z.object({ projectId: positive }).strict(), (ctx, input) => listFileFolders(ctx, input.projectId)));
router.post("/folder", endpoint(z.object({ projectId: positive, id: z.string().uuid().optional(), name: filename.optional(),
  parentId: z.string().uuid().nullable().optional(), expectedRevision: positive.optional(), remove: z.boolean().optional() }).strict(), writeFileFolder));
router.post("/place", endpoint(z.object({ projectId: positive, refId: z.string().min(1).max(128), folderId: z.string().uuid().nullable(), expectedRevision: positive }).strict(), placeProjectFile));
router.post("/history-visibility", endpoint(z.object({ ids: z.array(z.string().uuid()).min(1).max(100), hidden: z.boolean() }).strict(),
  (ctx, input) => setGenerationHistoryHidden(ctx, [...new Set(input.ids)], input.hidden)));
router.post("/history-import", endpoint(z.object({ mediaId: z.string().uuid(), projectId: positive }).strict(),
  (ctx, input) => importGenerationHistory(ctx, input, key => u.oss.fileExists(key))));

const fileIdentity = z.object({ assetId: positive, versionId: positive }).strict();
router.post("/url", endpoint(fileIdentity, async (ctx, input) => {
  const file = await managedFileVersion(ctx, input.assetId, input.versionId);
  if (resolveObjectStorageConfiguration().provider === "local") return { url: null };
  return { url: await u.oss.getPrivateFileUrl(file.key, { expiresInSeconds: 300 }) };
}));
// Local development has no signed object-store URLs. Keep the fallback authenticated
// instead of publishing a private reference path under a static /oss endpoint.
router.post("/content", async (req, res) => {
  try {
    const input = fileIdentity.parse(req.body), file = await managedFileVersion(context(req), input.assetId, input.versionId);
    const mime: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
      ".gif": "image/gif", ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mp3": "audio/mpeg",
      ".wav": "audio/wav", ".m4a": "audio/mp4", ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8" };
    res.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      "Content-Type": mime[path.extname(file.key).toLowerCase()] || "application/octet-stream" });
    const safeName = String(file.name || "fanjin-file").replace(/[\p{Cc}\p{Cf}\\/]/gu, "").slice(0, 200);
    res.setHeader("Content-Disposition", `attachment; filename="fanjin-file"; filename*=UTF-8''${encodeURIComponent(safeName)}`);
    if (resolveObjectStorageConfiguration().provider !== "local") {
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.on("close", abort);
      const timer = setTimeout(abort, 300_000);
      try {
        const upstream = await fetch(await u.oss.getPrivateFileUrl(file.key, { expiresInSeconds: 300 }), { signal: controller.signal, redirect: "error" });
        if (!upstream.ok || !upstream.body) throw new Error("Object delivery unavailable");
        const length = upstream.headers.get("content-length");
        if (length && /^\d+$/.test(length)) res.setHeader("Content-Length", length);
        await pipeline(Readable.fromWeb(upstream.body as any), res, { signal: controller.signal });
        return;
      } finally { clearTimeout(timer); res.off("close", abort); }
    }
    return res.send(await u.oss.getFile(file.key));
  } catch (error) {
    if (res.headersSent || res.destroyed) { if (!res.destroyed) res.destroy(); return; }
    if (error instanceof AssetLibraryError) return res.status(error.status).send({ message: error.message });
    if (error instanceof z.ZodError) return res.status(400).send({ message: "文件参数无效" });
    return res.status(502).send({ message: "文件暂时无法读取，请重试" });
  }
});
export default router;
