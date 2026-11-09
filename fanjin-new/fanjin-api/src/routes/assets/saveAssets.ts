import express from "express";
import crypto from "node:crypto";
import u from "@/utils";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { insertAndReturnId } from "@/lib/dbDialect";
import { imageMimeExtensions, parseBase64DataUrl } from "@/lib/mediaDataUrl";
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
const router = express.Router();

// 保存资产图片
export default router.post(
  "/",
  requireProjectPermission("project:write"),
  validateFields({
    id: z.number(),
    projectId: z.number(),
    base64: z.string().optional().nullable(),
    type: z.enum(["role", "scene", "tool"]),
    prompt: z.string().optional().nullable(),
    imageId: z.number().optional().nullable(),
  }),
  async (req, res) => {
    const { id, base64, type, prompt, projectId, imageId } = req.body;
    const asset = await u.db("o_assets")
      .where({ id, projectId, deletionState: "active" })
      .select("id")
      .first();
    if (!asset) {
      return res.status(404).send(error("资产不存在或正在删除"));
    }
    if (base64) {
      let parsed;
      try {
        parsed = parseBase64DataUrl(base64, imageMimeExtensions, "图片");
      } catch (err) {
        return res.status(400).send(error(err instanceof Error ? err.message : "图片格式不支持"));
      }
      // 生成新的图片路径
      const intentId = uuidv4();
      const savePath = `/${projectId}/${type}/${intentId}.${parsed.ext}`;
      let durableWrite: DurableObjectWriteResult | null = null;
      try {
        durableWrite = await writeObjectWithDurableIntent({
          purpose: "direct_upload",
          workspaceId: String((req as any).project?.workspaceId || ""),
          projectId,
          body: parsed.data,
          storageKey: () => savePath,
          writerIdPrefix: "asset-image-save",
        }, {
          database: knexDb,
          idFactory: () => intentId,
          writer: u.oss,
        });
        await knexDb.transaction(async (transaction) => {
          const idData = await insertAndReturnId(transaction, "o_image", {
            assetsId: id,
            filePath: savePath,
            storageKey: durableWrite!.storageKey,
            type,
            state: "已完成",
          });
          await createPortraitAdmissionForUpload({
            database: transaction,
            workspaceId: String((req as any).project?.workspaceId || ""),
            projectId,
            assetId: id,
            assetVersionId: idData,
            mediaType: "image",
            sourceSha256: crypto.createHash("sha256").update(parsed.data).digest("hex"),
          });
          const updated = await transaction("o_assets")
            .where({ id, projectId, deletionState: "active" })
            .update({
              prompt: prompt ?? "",
              imageId: idData,
            });
          if (Number(updated) !== 1) {
            throw new Error("资产在图片持久化期间发生变化");
          }
          await commitObjectWriteIntentInTransaction(
            transaction,
            durableWrite!.claim,
            {
              version: "object-write-reference.v1",
              table: "o_image",
              rowId: String(idData),
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
        return res.status(500).send(error("保存资产图片失败"));
      }
    } else {
      const selectedImage = imageId == null
        ? null
        : await u.db("o_image")
          .where({
            id: imageId,
            assetsId: id,
            deletionState: "active",
          })
          .select("id")
          .first();
      if (imageId != null && !selectedImage) {
        return res.status(404).send(error("图片版本不存在或正在删除"));
      }
      const updated = await u.db("o_assets")
        .where({ id, projectId, deletionState: "active" })
        .update({
          prompt: prompt ?? "",
          imageId,
        });
      if (Number(updated) !== 1) {
        return res.status(409).send(error("资产状态已变化"));
      }
    }
    return res.status(200).send(success({ message: "保存资产图片成功" }));
  },
);
