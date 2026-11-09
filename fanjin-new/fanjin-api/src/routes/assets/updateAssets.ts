import { db } from "@/utils/db";
import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";
import { AssetLibraryError, assertAssetLibraryPermission, assetLibrarySchemaAvailable } from "@/lib/accountWorkspaceAssetLibrary";
import { FILE_METADATA } from "@/lib/migrations/assetFileManager";
import { fileDisplayName } from "@/lib/assetFileManager";
const router = express.Router();

// 更新资产
export default router.post(
  "/",
  requireProjectPermission("project:write"),
  validateFields({
    id: z.number(),
    projectId: z.number(),
    type: z.enum(["role", "scene", "tool"]).optional(),
    name: z.string(),
    describe: z.string(),
    remark: z.string().optional().nullable(),
    prompt: z.string().optional().nullable(),
  }),
  async (req, res) => {
    const { id, projectId, type, name, describe, remark, prompt } = req.body;
    try {
    const updated = await db.transaction(async trx => {
      if (await assetLibrarySchemaAvailable(trx)) {
        await trx("o_asset_ownership").where({ assetId: id }).forUpdate().first();
        await assertAssetLibraryPermission({ database: trx, workspaceId: String((req as any).auth?.workspaceId || ""),
          actorUserId: Number((req as any).auth?.user?.id || 0), assetId: id, permission: "manage" });
      }
      if (type) {
        const asset = await trx("o_assets").where({ id, projectId, deletionState: "active" }).first();
        if (!asset) throw new AssetLibraryError("FILE_NOT_FOUND", "资产不存在或正在删除", 404);
        if (!["role", "scene", "tool"].includes(asset.type)) {
          throw new AssetLibraryError("ASSET_TYPE_IMMUTABLE", "媒体文件不能转换为角色、场景或道具", 400);
        }
      }
      if (await trx.schema.hasTable(FILE_METADATA)) {
        await trx(FILE_METADATA).insert({ assetId: id, revision: 1, tags: "[]", updatedAt: Date.now() }).onConflict("assetId").ignore();
        const metadata = await trx(FILE_METADATA).where({ assetId: id }).forUpdate().first();
        if (metadata.trashedAt != null) throw new AssetLibraryError("FILE_IN_TRASH", "请先恢复文件再修改", 409);
        await trx(FILE_METADATA).where({ assetId: id }).update({ revision: Number(metadata.revision) + 1, updatedAt: Date.now() });
      }
      const count = await trx("o_assets").where({
      id,
      projectId,
      deletionState: "active",
    }).update({
      name: fileDisplayName(name),
      describe,
      remark,
      prompt,
      ...(type ? { type } : {}),
    });
      if (Number(count) !== 1) throw new AssetLibraryError("FILE_NOT_FOUND", "资产不存在或正在删除", 404);
      return count;
    });
    if (Number(updated) !== 1) {
      return res.status(404).send({ message: "资产不存在或正在删除" });
    }
    res.status(200).send(success({ message: "更新资产成功" }));
    } catch (error) {
      if (error instanceof AssetLibraryError) return res.status(error.status).send({ code: error.code, message: error.message });
      throw error;
    }
  },
);
