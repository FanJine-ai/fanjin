import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { insertAndReturnId } from "@/lib/dbDialect";
import { audioMimeExtensions, parseBase64DataUrl } from "@/lib/mediaDataUrl";
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
import { registerAccountOwnedAssetIfAvailable } from "@/lib/accountWorkspaceAssetLibrary";
const router = express.Router();

// 新增资产
export default router.post(
  "/",
  requireProjectPermission("project:write"),
  validateFields({
    name: z.string(),
    describe: z.string(),
    projectId: z.number(),
    assetsItem: z.array(
      z.object({
        base64: z.string(),
        prompt: z.string(),
        describe: z.string(),
        name: z.string(),
      }),
    ),
  }),
  async (req, res) => {
    const { name, describe, projectId, assetsItem } = req.body;
    let parsedItems;
    try {
      parsedItems = assetsItem.map((item: {
        base64: string;
        prompt: string;
        describe: string;
        name: string;
      }) => ({
        ...item,
        parsed: parseBase64DataUrl(
          item.base64,
          audioMimeExtensions,
          "音频",
        ),
      }));
    } catch (cause) {
      return res.status(400).send(
        error(cause instanceof Error ? cause.message : "音频格式不支持"),
      );
    }
    const durableWrites: Array<{
      item: typeof parsedItems[number];
      filePath: string;
      durable: DurableObjectWriteResult;
    }> = [];
    try {
      for (const item of parsedItems) {
        const intentId = u.uuid();
        const filePath =
          `/${projectId}/assets/audio/${intentId}.${item.parsed.ext}`;
        const durable = await writeObjectWithDurableIntent({
          purpose: "direct_upload",
          workspaceId: String((req as any).project?.workspaceId || ""),
          projectId,
          body: item.parsed.data,
          storageKey: () => filePath,
          writerIdPrefix: "audio-asset-add",
        }, {
          database: knexDb,
          idFactory: () => intentId,
          writer: u.oss,
        });
        durableWrites.push({ item, filePath, durable });
      }
      await knexDb.transaction(async (transaction) => {
        const now = Date.now();
        const actorUserId = Number((req as any).auth?.user?.id || (req as any).user?.id || 0);
        const workspaceId = String((req as any).project?.workspaceId || "");
        const id = await insertAndReturnId(transaction, "o_assets", {
          name,
          describe,
          type: "audio",
          projectId,
          startTime: now,
        });
        if (actorUserId > 0 && workspaceId) {
          await registerAccountOwnedAssetIfAvailable({
            transaction,
            assetId: Number(id),
            projectId,
            workspaceId,
            actorUserId,
            idempotencyKey: `audio-asset:${id}:ownership`,
            now,
          });
        }
        for (const entry of durableWrites) {
          const assetsId = await insertAndReturnId(
            transaction,
            "o_assets",
            {
              prompt: entry.item.prompt,
              assetsId: id,
              type: "audio",
              describe: entry.item.describe,
              name: entry.item.name,
              projectId,
              startTime: now,
            },
          );
          const imageId = await insertAndReturnId(
            transaction,
            "o_image",
            {
              filePath: entry.filePath,
              storageKey: entry.durable.storageKey,
              type: "audio",
              assetsId,
              state: "已完成",
            },
          );
          const updated = await transaction("o_assets")
            .where({ id: assetsId, projectId })
            .update({ imageId });
          if (Number(updated) !== 1) {
            throw new Error("音频资产引用写入失败");
          }
          if (actorUserId > 0 && workspaceId) {
            await registerAccountOwnedAssetIfAvailable({
              transaction,
              assetId: Number(assetsId),
              projectId,
              workspaceId,
              actorUserId,
              assetVersionId: `image:${imageId}`,
              idempotencyKey: `audio-asset:${entry.durable.intentId}:ownership`,
              now,
            });
          }
          await commitObjectWriteIntentInTransaction(
            transaction,
            entry.durable.claim,
            {
              version: "object-write-reference.v1",
              table: "o_image",
              rowId: String(imageId),
              workspaceId: String(
                (req as any).project?.workspaceId || "",
              ),
              projectId,
              storageKey: entry.durable.storageKey,
            },
          );
        }
      });
    } catch (cause) {
      await Promise.all(durableWrites.map(({ durable }) =>
        queueDurableObjectWriteCompensation(
          durable.claim,
          cause,
          { database: knexDb },
        ).catch(() => undefined)));
      return res.status(500).send(error("新增音频资产持久化失败"));
    }
    return res.status(200).send(success({ message: "新增资产成功" }));
  },
);
