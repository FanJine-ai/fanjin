import { FILE_METADATA } from "@/lib/migrations/assetFileManager";
import { assetLibrarySchemaAvailable, listAuthorizedAssetIds } from "@/lib/accountWorkspaceAssetLibrary";
import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";
import { normalizeAssetTags } from "@/lib/assetMetadata";
const router = express.Router();

const requireAssetProjectRead: express.RequestHandler = (req, res, next) => {
  if (req.body?.projectId != null) {
    return requireProjectPermission("project:read")(req, res, next);
  }
  return next();
};

const validateAssetList = validateFields({
  projectId: z.number().optional().nullable(),
  type: z.string(),
  name: z.string().optional(),
  page: z.number(),
  limit: z.number(),
});

const listAssetRows: express.RequestHandler = async (req, res) => {
  const { projectId, type, name, page = 1, limit = 10 } = req.body;
  const workspaceId = (req as any).auth?.workspaceId || "default";
  const offset = (page - 1) * limit;
  let query = u
    .db("o_assets")
    .innerJoin("o_project", "o_assets.projectId", "o_project.id")
    .leftJoin("o_image", function () {
      this.on("o_assets.imageId", "=", "o_image.id")
        .andOnVal("o_image.deletionState", "active");
    })
    .select("o_assets.*", "o_image.filePath", "o_image.state")
    .andWhere("o_assets.type", type)
    .andWhere("o_assets.deletionState", "active")
    .andWhere("o_project.deletionState", "active");
  if (projectId != null) query = query.where("o_assets.projectId", projectId);
  else query = query.where("o_project.workspaceId", workspaceId);
  if (name) {
    query = query.andWhere("o_assets.name", "like", `%${name}%`);
  }
  const hasFileMetadata = await u.db.schema.hasTable(FILE_METADATA);
  if (hasFileMetadata) {
    query.leftJoin(`${FILE_METADATA} as metadata`, "metadata.assetId", "o_assets.id");
    query.select("metadata.tags as assetTags");
  }
  const authorizedIds = await assetLibrarySchemaAvailable(u.db)
    ? await listAuthorizedAssetIds({ database: u.db, workspaceId, actorUserId: Number((req as any).auth?.user?.id || 0), view: "all", permission: "view" })
    : null;
  if (authorizedIds) query.whereIn("o_assets.id", authorizedIds);
  if (hasFileMetadata) query.whereNotExists(u.db(FILE_METADATA).select("assetId")
    .whereRaw('"o_asset_file_metadata"."assetId" = "o_assets"."id"').whereNotNull("trashedAt"));
  // 分页查询
  const parentAssets = await query
    .where("o_assets.assetsId", null).offset(offset).limit(limit);

  // 获取所有子资产供关联使用
  let childQuery = u
    .db("o_assets")
    .innerJoin("o_project", "o_assets.projectId", "o_project.id")
    .leftJoin("o_image", function () {
      this.on("o_assets.imageId", "=", "o_image.id")
        .andOnVal("o_image.deletionState", "active");
    })
    .select("o_assets.*", "o_image.filePath", "o_image.state", "o_image.errorReason")
    .andWhere("o_assets.type", type)
    .andWhere("o_assets.deletionState", "active")
    .andWhere("o_project.deletionState", "active")
    .whereNotNull("o_assets.assetsId");
  if (projectId != null) childQuery = childQuery.where("o_assets.projectId", projectId);
  else childQuery = childQuery.where("o_project.workspaceId", workspaceId);
  if (name) {
    childQuery = childQuery.andWhere("o_assets.name", "like", `%${name}%`);
  }
  if (authorizedIds) childQuery.whereIn("o_assets.id", authorizedIds);
  if (hasFileMetadata) childQuery.leftJoin(`${FILE_METADATA} as metadata`, "metadata.assetId", "o_assets.id");
  if (hasFileMetadata) childQuery.select("metadata.tags as assetTags");
  if (hasFileMetadata) childQuery.whereNotExists(u.db(FILE_METADATA).select("assetId")
    .whereRaw('"o_asset_file_metadata"."assetId" = "o_assets"."id"').whereNotNull("trashedAt"));
  const childAssets = await childQuery;

  // 为每个子资产添加图片地址
  const childAssetsWithSrc = await Promise.all(
    childAssets.map(async (child) => {
      const { assetTags, ...childFields } = child as any;
      return {
      ...childFields,
      tags: normalizeAssetTags(assetTags),
      src: child.filePath && (isReferenceFilePath(child.filePath)
        ? referenceFileUrl(child.id)
        : await filterTypeGetFileUrl(child.filePath!, child.type)),
      };
    }),
  );

  // 为每个父资产添加子资产
  const result = await Promise.all(
    parentAssets.map(async (parent) => {
      const { assetTags, ...parentFields } = parent as any;
      return {
      ...parentFields,
      tags: normalizeAssetTags(assetTags),
      sonAssets: childAssetsWithSrc.filter((child) => child.assetsId === parent.id),
      src: parent.filePath && (isReferenceFilePath(parent.filePath)
        ? referenceFileUrl(parent.id)
        : await filterTypeGetFileUrl(parent.filePath!, parent.type)),
      ...(parent.type == "audio" ? { sex: parent.describe?.split("|")[0], describe: parent.describe?.split("|")[1] } : {}),
      };
    }),
  );

  // 统计总数
  let totalQueryBuilder = u
    .db("o_assets")
    .innerJoin("o_project", "o_assets.projectId", "o_project.id")
    .where("o_assets.type", type)
    .andWhere("o_assets.assetsId", null)
    .andWhere("o_assets.deletionState", "active")
    .andWhere("o_project.deletionState", "active")
    .andWhere((qb) => {
      if (name) {
        qb.andWhere("o_assets.name", "like", `%${name}%`);
      }
    });
  if (projectId != null) totalQueryBuilder = totalQueryBuilder.where("o_assets.projectId", projectId);
  else totalQueryBuilder = totalQueryBuilder.where("o_project.workspaceId", workspaceId);
  if (authorizedIds) totalQueryBuilder.whereIn("o_assets.id", authorizedIds);
  if (hasFileMetadata) totalQueryBuilder.whereNotExists(u.db(FILE_METADATA).select("assetId")
    .whereRaw('"o_asset_file_metadata"."assetId" = "o_assets"."id"').whereNotNull("trashedAt"));
  const totalQuery = (await totalQueryBuilder
    .count("* as total")
    .first()) as any;
  res.status(200).send(success({ data: result, total: totalQuery?.total }));
};

router.get(
  "/",
  (req, res, next) => {
    req.body = {
      projectId: req.query.projectId === undefined
        ? undefined
        : Number(req.query.projectId),
      type: req.query.type,
      name: req.query.name,
      page: req.query.page === undefined ? 1 : Number(req.query.page),
      limit: req.query.limit === undefined ? 10 : Number(req.query.limit),
    };
    next();
  },
  requireAssetProjectRead,
  validateAssetList,
  listAssetRows,
);

router.post("/", requireAssetProjectRead, validateAssetList, listAssetRows);

export default router;

async function filterTypeGetFileUrl(url: string, type: string) {
  if (type == "role" || type == "tool" || type == "scene") {
    return await u.oss.getSmallImageUrl(url);
  } else {
    return await u.oss.getFileUrl(url);
  }
}

function isReferenceFilePath(value: unknown): boolean {
  return /\/assets\/references\/[^/]+$/i.test(String(value || "").replace(/\\/g, "/"));
}

function referenceFileUrl(assetId: number): string {
  return `/api/assets/getReferenceFile?id=${encodeURIComponent(String(assetId))}&disposition=inline`;
}
