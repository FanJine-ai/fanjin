import express from "express";
import crypto from "node:crypto";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { insertAndReturnId } from "@/lib/dbDialect";
import { error } from "@/lib/responseFormat";
import { parseBase64DataUrl, uploadMimeExtensions } from "@/lib/mediaDataUrl";
import { requireProjectPermission } from "@/middleware/projectAccess";
import {
  queueDurableObjectWriteCompensation,
  writeObjectWithDurableIntent,
  type DurableObjectWriteResult,
} from "@/lib/durableObjectWrite";
import {
  commitObjectWriteIntentInTransaction,
} from "@/lib/objectWriteIntent";
import { db as knexDb } from "@/utils/db";
import { createPortraitAdmissionForUpload } from "@/lib/portraitAdmissionStore";
import { registerAccountOwnedAssetIfAvailable } from "@/lib/accountWorkspaceAssetLibrary";
const router = express.Router();

// 文件上传（支持图片、音频、视频）
export default router.post(
  "/",
  requireProjectPermission("project:write"),
  validateFields({
    projectId: z.number().int().positive(),
    base64Data: z.string(),
    type: z.string().optional().default("clip"),
    name: z.string(),
  }),
  async (req, res) => {
    const { base64Data, projectId, type: requestedType = "clip", name } = req.body;
    let parsed;
    try {
      parsed = parseBase64DataUrl(base64Data, uploadMimeExtensions, "上传文件");
    } catch (err) {
      return res.status(400).send(error(err instanceof Error ? err.message : "上传文件格式不支持"));
    }
    // Business labels (role/scene/tool/clip) may only refine a matching MIME
    // family. A frame uploaded through this legacy clip endpoint is an image.
    const mediaType = parsed.mime.startsWith("image/") ? "image"
      : parsed.mime.startsWith("video/") ? "video" : "audio";
    const compatibleTypes = mediaType === "image" ? ["image", "role", "scene", "tool"]
      : mediaType === "video" ? ["video", "clip"] : ["audio"];
    const type = compatibleTypes.includes(requestedType) ? requestedType : mediaType;
    const ext = parsed.ext;
    const intentId = uuid();
    const savePath = `/${projectId}/assets/${intentId}.${ext}`;
    let durableWrite: DurableObjectWriteResult | null = null;
    let assetId = 0;
    let imageId = 0;
    const startTime = Date.now();
    try {
      durableWrite = await writeObjectWithDurableIntent({
        purpose: "direct_upload",
        workspaceId: String((req as any).project?.workspaceId || ""),
        projectId,
        body: parsed.data,
        storageKey: () => savePath,
        writerIdPrefix: "asset-upload",
      }, {
        database: knexDb,
        idFactory: () => intentId,
        writer: u.oss,
      });
      await knexDb.transaction(async (transaction) => {
        assetId = await insertAndReturnId(transaction, "o_assets", {
          type,
          projectId,
          name,
          startTime,
        });
        imageId = await insertAndReturnId(transaction, "o_image", {
          filePath: savePath,
          storageKey: durableWrite!.storageKey,
          type,
          assetsId: assetId,
          state: "已完成",
        });
        if (mediaType !== "audio") {
          await createPortraitAdmissionForUpload({
            database: transaction,
            workspaceId: String((req as any).project?.workspaceId || ""),
            projectId,
            assetId,
            assetVersionId: imageId,
            mediaType,
            sourceSha256: crypto.createHash("sha256").update(parsed.data).digest("hex"),
            now: startTime,
          });
        }
        const updated = await transaction("o_assets")
          .where({ id: assetId, projectId })
          .update({ imageId });
        if (Number(updated) !== 1) {
          throw new Error("上传资产引用写入失败");
        }
        const actorUserId = Number((req as any).auth?.user?.id || (req as any).user?.id || 0);
        const workspaceId = String((req as any).project?.workspaceId || "");
        if (actorUserId > 0 && workspaceId) {
          await registerAccountOwnedAssetIfAvailable({
            transaction,
            assetId,
            projectId,
            workspaceId,
            actorUserId,
            assetVersionId: `image:${imageId}`,
            idempotencyKey: `asset-upload:${intentId}:ownership`,
            now: startTime,
          });
        }
        await commitObjectWriteIntentInTransaction(
          transaction,
          durableWrite!.claim,
          {
            version: "object-write-reference.v1",
            table: "o_image",
            rowId: String(imageId),
            workspaceId: String((req as any).project?.workspaceId || ""),
            projectId,
            storageKey: durableWrite!.storageKey,
          },
        );
      });
    } catch (cause) {
      if (durableWrite) {
        await queueDurableObjectWriteCompensation(
          durableWrite.claim,
          cause,
          { database: knexDb },
        ).catch(() => undefined);
      }
      return res.status(500).send(error("上传文件持久化失败"));
    }
    return res.status(200).send(success({
      id: assetId,
      projectId,
      name,
      type,
      startTime,
      imageId,
      filePath: savePath,
      state: "已完成",
      sonAssets: [],
    }, "上传成功"));
  },
);
