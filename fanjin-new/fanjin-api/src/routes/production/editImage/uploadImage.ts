import express from "express";
import u from "@/utils";
import { success, error } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import { requireProjectPermission } from "@/middleware/projectAccess";
import {
  MAX_IMAGE_FLOW_UPLOAD_BASE64_LENGTH,
  parseImageFlowUploadDataUrl,
  persistImageFlowUpload,
} from "@/lib/imageFlowUpload";
const router = express.Router();

// 文件上传（支持图片、音频、视频）
export default router.post(
  "/",
  requireProjectPermission("project:write"),
  validateFields({
    projectId: z.number().int().positive(),
    scriptId: z.number().int().positive(),
    base64Data: z.string().min(1).max(
      MAX_IMAGE_FLOW_UPLOAD_BASE64_LENGTH + 128,
    ),
  }),
  async (req, res) => {
    const { base64Data, projectId, scriptId } = req.body;
    let upload;
    try {
      upload = parseImageFlowUploadDataUrl(base64Data);
    } catch {
      return res.status(400).send(error("不支持的文件类型"));
    }
    try {
      const persisted = await persistImageFlowUpload({
        projectId,
        scriptId,
        workspaceId: String((req as any).project?.workspaceId || ""),
        upload,
      }, {
        database: u.db,
        writer: u.oss,
      });
      return res.status(200).send(success(persisted.url));
    } catch {
      return res.status(500).send(error("上传图片持久化失败"));
    }
  },
);
