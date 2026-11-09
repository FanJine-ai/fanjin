import express from "express";
import { z } from "zod";
import { extractScriptImportFile, MAX_SCRIPT_IMPORT_BYTES, ScriptImportError } from "@/lib/scriptImport";
import { success } from "@/lib/responseFormat";
import { requireProjectPermission } from "@/middleware/projectAccess";

const router = express.Router();
const bodySchema = z.object({
  projectId: z.number().int().positive(),
  fileName: z.string().trim().min(1).max(255),
  dataUrl: z.string().min(1).max(Math.ceil(MAX_SCRIPT_IMPORT_BYTES / 3) * 4 + 128),
}).strict();

export default router.post("/", requireProjectPermission("project:write"), async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "剧本文件参数错误", code: "SCRIPT_IMPORT_REQUEST_INVALID" });
  const match = parsed.data.dataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[2].length % 4 !== 0 || Buffer.from(match[2], "base64").toString("base64") !== match[2]) {
    return res.status(400).send({ message: "上传文件编码无效", code: "SCRIPT_IMPORT_DATA_URL_INVALID" });
  }
  try {
    return res.status(200).send(success(await extractScriptImportFile({
      fileName: parsed.data.fileName, mimeType: match[1], data: Buffer.from(match[2], "base64"),
    })));
  } catch (error) {
    if (error instanceof ScriptImportError) return res.status(error.status).send({ message: error.message, code: error.code });
    throw error;
  }
});
