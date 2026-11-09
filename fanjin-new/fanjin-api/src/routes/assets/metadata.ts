import crypto from "node:crypto";
import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";
import { assetLibrarySchemaAvailable, assertAssetLibraryPermission } from "@/lib/accountWorkspaceAssetLibrary";
import { FILE_METADATA } from "@/lib/migrations/assetFileManager";
import { ASSET_USAGE_VALUES, setGroupTag, setUsageTag, type AssetUsage } from "@/lib/assetMetadata";
import { db } from "@/utils/db";

const router = express.Router();
const usage = z.enum(ASSET_USAGE_VALUES);
const projectInput = z.object({ projectId: z.number().int().positive() });

async function assertManage(trx: any, req: express.Request, assetId: number, projectId: number) {
  let asset = await trx("o_assets").where({ id: assetId, projectId, deletionState: "active" }).first();
  if (!asset) {
    const sharedAsset = await trx("o_assets").where({ id: assetId, deletionState: "active" }).first();
    const hasProjectRefs = await trx.schema.hasTable("o_project_asset_ref");
    const reference = sharedAsset && hasProjectRefs && await trx("o_project_asset_ref")
      .where({ assetId, projectId, workspaceId: String((req as any).auth?.workspaceId || "") })
      .whereNull("removedAt").first();
    if (!sharedAsset || !reference) throw new MetadataError(404, "资产不存在或未加入当前项目");
    asset = sharedAsset;
  }
  if (await assetLibrarySchemaAvailable(trx)) {
    await trx("o_asset_ownership").where({ assetId }).forUpdate().first();
    await assertAssetLibraryPermission({
      database: trx,
      workspaceId: String((req as any).auth?.workspaceId || ""),
      actorUserId: Number((req as any).auth?.user?.id || 0),
      assetId,
      permission: "manage",
    });
  }
  return asset;
}

class MetadataError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

router.post(
  "/metadata",
  requireProjectPermission("project:write"),
  validateFields({
    projectId: projectInput.shape.projectId,
    id: z.number().int().positive(),
    usage: usage.nullable().optional(),
  }),
  async (req, res) => {
    try {
      const { projectId, id, usage: nextUsage = null } = req.body as { projectId: number; id: number; usage?: AssetUsage | null };
      const result = await uUpdateMetadata(req, projectId, [id], (tags) => setUsageTag(tags, nextUsage));
      return res.status(200).send(success({ ...result, usage: nextUsage }));
    } catch (cause) {
      return sendMetadataError(res, cause);
    }
  },
);

router.post(
  "/groups",
  requireProjectPermission("project:write"),
  validateFields({
    projectId: projectInput.shape.projectId,
    name: z.string().trim().min(1).max(80),
    usage: z.enum(["role", "scene", "tool"]),
    assetIds: z.array(z.number().int().positive()).min(1).max(100),
  }),
  async (req, res) => {
    try {
      const { projectId, name, usage: groupUsage, assetIds } = req.body as { projectId: number; name: string; usage: AssetUsage; assetIds: number[] };
      const group = { id: crypto.randomUUID(), name, usage: groupUsage };
      const uniqueIds = [...new Set(assetIds)];
      const result = await uUpdateMetadata(req, projectId, uniqueIds, (tags) => {
        const grouped = setGroupTag(tags, group);
        return setUsageTag(grouped, groupUsage);
      });
      return res.status(200).send(success({ group, ...result }));
    } catch (cause) {
      return sendMetadataError(res, cause);
    }
  },
);

async function uUpdateMetadata(
  req: express.Request,
  projectId: number,
  assetIds: number[],
  transform: (tags: unknown) => string[],
) {
  return db.transaction(async (trx) => {
    if (!(await trx.schema.hasTable(FILE_METADATA))) throw new MetadataError(503, "资产分类存储尚未就绪，请稍后重试");
    for (const assetId of assetIds) {
      const asset = await assertManage(trx, req, assetId, projectId);
      await trx(FILE_METADATA).insert({ assetId, revision: 1, tags: "[]", updatedAt: Date.now() }).onConflict("assetId").ignore();
      const tagsRow = await trx(FILE_METADATA).where({ assetId }).forUpdate().first();
      const tags = transform(tagsRow?.tags || "[]");
      const revision = Number(tagsRow?.revision || 0) + 1;
      await trx(FILE_METADATA).where({ assetId }).update({ revision, tags: JSON.stringify(tags), updatedAt: Date.now() });
      void asset;
    }
    return { assetIds };
  });
}

function sendMetadataError(res: express.Response, cause: unknown) {
  if (cause instanceof MetadataError) return res.status(cause.status).send(error(cause.message));
  const message = cause instanceof Error ? cause.message : "资产分类失败，请重试";
  return res.status(500).send(error(message));
}

export default router;
