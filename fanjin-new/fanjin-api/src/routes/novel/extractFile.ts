import express from "express";
import { z } from "zod";

import {
  extractNovelImportFile,
  MAX_NOVEL_IMPORT_BYTES,
  NovelImportError,
} from "@/lib/novelImport";
import { success } from "@/lib/responseFormat";
import { requireProjectPermission } from "@/middleware/projectAccess";

const router = express.Router();
const MAX_BASE64_LENGTH = Math.ceil(MAX_NOVEL_IMPORT_BYTES / 3) * 4;

export const bodySchema = z.object({
  projectId: z.number().int().positive(),
  fileName: z.string().trim().min(1).max(255),
  dataUrl: z.string().min(1).max(MAX_BASE64_LENGTH + 128),
}).strict();

function parseDataUrl(value: string): { mimeType: string; data: Buffer } {
  const match = value.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[2].length % 4 !== 0) {
    throw new NovelImportError(400, "NOVEL_IMPORT_DATA_URL_INVALID", "上传文件编码无效");
  }
  const data = Buffer.from(match[2], "base64");
  if (data.toString("base64") !== match[2]) {
    throw new NovelImportError(400, "NOVEL_IMPORT_DATA_URL_INVALID", "上传文件编码无效");
  }
  return { mimeType: match[1].trim().toLowerCase(), data };
}

export default router.post(
  "/",
  requireProjectPermission("project:write"),
  async (req, res) => {
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).send({
        message: "小说文件参数错误",
        code: "NOVEL_IMPORT_REQUEST_INVALID",
        errors: parsed.error.issues,
      });
    }
    try {
      const encoded = parseDataUrl(parsed.data.dataUrl);
      return res.status(200).send(success(await extractNovelImportFile({
        fileName: parsed.data.fileName,
        mimeType: encoded.mimeType,
        data: encoded.data,
      })));
    } catch (error) {
      if (error instanceof NovelImportError) {
        return res.status(error.status).send({ message: error.message, code: error.code });
      }
      throw error;
    }
  },
);
