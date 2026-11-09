import { AssetLibraryError, assetLibrarySchemaAvailable, assertAssetLibraryPermission, registerAccountOwnedAssetIfAvailable } from "@/lib/accountWorkspaceAssetLibrary";
import { FILE_METADATA } from "@/lib/migrations/assetFileManager";
import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { insertAndReturnId } from "@/lib/dbDialect";
import {
  audioMimeExtensions,
  parseBase64DataUrl,
} from "@/lib/mediaDataUrl";
import { requireProjectPermission } from "@/middleware/projectAccess";
import {
  queueDurableObjectWriteCompensation,
  writeObjectWithDurableIntent,
  type DurableObjectWriteResult,
} from "@/lib/durableObjectWrite";
import {
  commitObjectWriteIntentInTransaction,
} from "@/lib/objectWriteIntent";
import { db } from "@/utils/db";
const router = express.Router();

// 新增资产
export default router.post(
  "/",
  requireProjectPermission("project:write"),
  validateFields({
    id: z.number(),
    name: z.string(),
    describe: z.string(),
    projectId: z.number(),
    assetsItem: z.array(
      z.object({
        src: z.string().optional(),
        id: z.number().optional(),
        base64: z.string().optional(),
        prompt: z.string(),
        describe: z.string(),
        name: z.string(),
      }),
    ),
  }),
  async (req, res) => {
    const { id, name, describe, projectId, assetsItem } = req.body;
    const parent = await u.db("o_assets")
      .where({ id, projectId, deletionState: "active" })
      .first();
    if (!parent) {
      return res.status(404).send(error("音频资产不存在"));
    }
    const existingItems = await u
      .db("o_assets as asset")
      .leftJoin("o_image as image", "asset.imageId", "image.id")
      .where({
        "asset.assetsId": id,
        "asset.projectId": projectId,
        "asset.deletionState": "active",
      })
      .select(
        "asset.id",
        "asset.imageId",
        "image.id as activeImageId",
        "image.filePath",
        "image.deletionState as imageDeletionState",
      );
    const existingById = new Map(
      existingItems.map((item: any) => [Number(item.id), item]),
    );
    const incomingIds = assetsItem
      .filter((item: { id?: number }) => item.id != null)
      .map((item: { id?: number }) => Number(item.id));
    if (incomingIds.some((itemId: number) => !existingById.has(itemId))) {
      return res.status(404).send(error("音频子资产不存在或不属于当前资产"));
    }
    if (existingItems.some((item: any) =>
      item.imageId != null
      && (
        Number(item.activeImageId || 0) !== Number(item.imageId)
        || String(item.imageDeletionState || "active") !== "active"
      ))) {
      return res.status(409).send(
        error("音频子资产图片正在删除，已拒绝更新", {
          code: "DELETION_RESOURCE_NOT_ACTIVE",
        }),
      );
    }
    const incomingIdSet = new Set(incomingIds);
    const toDeleteIds = existingItems
      .map((item: any) => Number(item.id))
      .filter((existingId: number) => !incomingIdSet.has(existingId));
    const replacesExistingFile = assetsItem.some((item: {
      id?: number;
      src?: string;
      base64?: string;
    }) => {
      if (!item.id) return false;
      if (item.base64) return true;
      if (!item.src) return false;
      return u.replaceUrl(item.src)
        !== u.replaceUrl(String(existingById.get(Number(item.id))?.filePath || ""));
    });
    if (toDeleteIds.length > 0 || replacesExistingFile) {
      return res.status(501).send(
        error("音频子资产删除或文件替换工作流尚未上线，已拒绝破坏性更新", {
          code: "DELETION_ASSET_WORKFLOW_UNAVAILABLE",
        }),
      );
    }

    type AudioAssetUpdateItem = {
      src?: string;
      id?: number;
      base64?: string;
      prompt: string;
      describe: string;
      name: string;
    };
    const normalizedItems: AudioAssetUpdateItem[] =
      (assetsItem as AudioAssetUpdateItem[]).map((item) => ({
      ...item,
      src: item.src ? u.replaceUrl(item.src) : undefined,
    }));
    const parsedNewItems = new Map<number, ReturnType<
      typeof parseBase64DataUrl
    >>();
    try {
      normalizedItems.forEach((item, index) => {
        if (item.base64) {
          parsedNewItems.set(
            index,
            parseBase64DataUrl(
              item.base64,
              audioMimeExtensions,
              "音频",
            ),
          );
        }
      });
    } catch (cause) {
      return res.status(400).send(
        error(cause instanceof Error ? cause.message : "音频格式不支持"),
      );
    }
    const durableWrites = new Map<number, {
      filePath: string;
      durable: DurableObjectWriteResult;
    }>();
    try {
      for (const [index, parsed] of parsedNewItems) {
        const intentId = u.uuid();
        const filePath =
          `/${projectId}/assets/audio/${intentId}.${parsed.ext}`;
        const durable = await writeObjectWithDurableIntent({
          purpose: "direct_upload",
          workspaceId: String((req as any).project?.workspaceId || ""),
          projectId,
          body: parsed.data,
          storageKey: () => filePath,
          writerIdPrefix: "audio-asset-update",
        }, {
          database: db,
          idFactory: () => intentId,
          writer: u.oss,
        });
        durableWrites.set(index, { filePath, durable });
      }

      await db.transaction(async (transaction) => {
        const workspaceId = String((req as any).project?.workspaceId || "");
        const actorUserId = Number((req as any).auth?.user?.id || 0);
        await transaction("o_project").where({ id: projectId, workspaceId, deletionState: "active" }).forUpdate().first();
        if (await assetLibrarySchemaAvailable(transaction)) {
          for (const assetId of [id, ...incomingIds]) {
            await transaction("o_asset_ownership").where({ assetId }).forUpdate().first();
            await assertAssetLibraryPermission({ database: transaction, workspaceId, actorUserId, assetId, permission: "manage" });
            if (await transaction.schema.hasTable(FILE_METADATA)) {
              await transaction(FILE_METADATA).insert({ assetId, revision: 1, tags: "[]", updatedAt: Date.now() }).onConflict("assetId").ignore();
              const metadata = await transaction(FILE_METADATA).where({ assetId }).forUpdate().first();
              if (metadata.trashedAt != null) throw new AssetLibraryError("FILE_IN_TRASH", "请先恢复音频文件再修改", 409);
              await transaction(FILE_METADATA).where({ assetId }).update({ revision: Number(metadata.revision) + 1, updatedAt: Date.now() });
            }
          }
        }
        const updatedParent = await transaction("o_assets")
          .where({ id, projectId, deletionState: "active" })
          .update({ name, describe });
        if (Number(updatedParent) !== 1) {
          throw new Error("音频父资产状态已变化");
        }
        for (const [index, item] of normalizedItems.entries()) {
          if (item.id) {
            const updated = await transaction("o_assets").where({
              id: item.id,
              assetsId: id,
              projectId,
              deletionState: "active",
            }).update({
              prompt: item.prompt,
              describe: item.describe,
              name: item.name,
            });
            if (Number(updated) !== 1) {
              throw new Error("音频子资产状态已变化");
            }
            continue;
          }
          const uploaded = durableWrites.get(index);
          const filePath = uploaded?.filePath ?? item.src;
          if (!filePath) {
            throw new Error("新增音频子资产缺少文件");
          }
          const assetsId = await insertAndReturnId(
            transaction,
            "o_assets",
            {
              prompt: item.prompt,
              assetsId: id,
              type: "audio",
              projectId,
              describe: item.describe,
              name: item.name,
              startTime: Date.now(),
            },
          );
          const imageId = await insertAndReturnId(
            transaction,
            "o_image",
            {
              filePath,
              storageKey: uploaded?.durable.storageKey ?? null,
              type: "audio",
              assetsId,
              state: "已完成",
            },
          );
          const linked = await transaction("o_assets")
            .where({ id: assetsId, projectId })
            .update({ imageId });
          if (Number(linked) !== 1) {
            throw new Error("新增音频子资产引用写入失败");
          }
          await registerAccountOwnedAssetIfAvailable({ transaction, assetId: Number(assetsId), projectId, workspaceId,
            actorUserId, assetVersionId: `image:${imageId}`, idempotencyKey: `audio-update:${assetsId}:ownership` });
          if (uploaded) {
            await commitObjectWriteIntentInTransaction(
              transaction,
              uploaded.durable.claim,
              {
                version: "object-write-reference.v1",
                table: "o_image",
                rowId: String(imageId),
                workspaceId: String(
                  (req as any).project?.workspaceId || "",
                ),
                projectId,
                storageKey: uploaded.durable.storageKey,
              },
            );
          }
        }
      });
    } catch (cause) {
      console.error(
        "[audio-asset-update] persistence failed",
        cause instanceof Error ? cause.message : cause,
      );
      await Promise.all([...durableWrites.values()].map(({ durable }) =>
        queueDurableObjectWriteCompensation(
          durable.claim,
          cause,
          { database: db },
        ).catch(() => undefined)));
      if (cause instanceof AssetLibraryError) return res.status(cause.status).send({ code: cause.code, message: cause.message });
      return res.status(500).send(error("更新音频资产持久化失败"));
    }

    return res.status(200).send(success({ message: "新增资产成功" }));
  },
);
