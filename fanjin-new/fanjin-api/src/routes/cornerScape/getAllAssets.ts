import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";
const router = express.Router();

export const CORNER_SCAPE_ASSET_TYPES = ["role", "scene", "tool", "image", "clip"] as const;
const cornerScapeAssetTypeSchema = z.enum(CORNER_SCAPE_ASSET_TYPES);

export default router.post(
  "/",
  requireProjectPermission("project:read"),
  validateFields({
    projectId: z.number(),
    type: z.array(cornerScapeAssetTypeSchema).optional(),
  }),
  async (req, res) => {
    const { projectId, type } = req.body;
    const requestedTypes = Array.isArray(type) && type.length > 0
      ? [...new Set(type)]
      : [...CORNER_SCAPE_ASSET_TYPES];
    const data = await u
      .db("o_assets")
      .leftJoin("o_image", function () {
        this.on("o_assets.imageId", "=", "o_image.id")
          .andOnVal("o_image.deletionState", "active");
      })
      .select(
        "o_assets.*",
        "o_image.filePath",
        "o_image.state",
        "o_image.model",
        "o_image.resolution",
        "o_image.errorReason",
        "o_image.id as imageId",
      )
      .where("o_assets.projectId", projectId)
      .andWhere("o_assets.deletionState", "active")
      .whereIn("o_assets.type", requestedTypes)
      .orderByRaw(`CASE o_assets.type WHEN 'role' THEN 1 WHEN 'scene' THEN 2 WHEN 'tool' THEN 3 WHEN 'image' THEN 4 WHEN 'clip' THEN 5 ELSE 6 END`)
      .orderBy("o_assets.id", "asc");
    const assets2AudioData = await u
      .db("o_assetsRole2Audio")
      .leftJoin("o_assets", "o_assets.id", "o_assetsRole2Audio.assetsAudioId")
      .whereIn(
        "o_assetsRole2Audio.assetsRoleId",
        data.map((i: any) => i.id!),
      )
      .select("o_assets.id", "o_assets.name", "o_assetsRole2Audio.assetsRoleId");
    const repleAssets: Record<number, { id: number; name: string }[]> = {};
    assets2AudioData.forEach((item) => {
      if (!repleAssets[item.assetsRoleId]) repleAssets[item.assetsRoleId] = [item];
      else repleAssets[item.assetsRoleId].push(item);
    });
    const result = await Promise.all(
      data.map(async (parent: any) => {
        const historyImages = await u.db("o_image")
          .where({
            assetsId: parent.id,
            deletionState: "active",
          })
          .andWhere("state", "已完成")
          .orderBy("id", "desc")
          .select("id", "filePath", "model", "resolution");
        const historyImagesWithUrl = await Promise.all(
          historyImages.map(async (img: any) => ({
            id: img.id,
            filePath: img.filePath && (await u.oss.getSmallImageUrl(img.filePath)),
            model: img.model || null,
            resolution: img.resolution || null,
          })),
        );
        return {
          ...parent,
          filePath: parent.filePath && (await u.oss.getSmallImageUrl(parent.filePath!)),
          historyImages: historyImagesWithUrl,
          relepedAudio: repleAssets[parent.id] ?? [],
        };
      }),
    );
    res.status(200).send(success(result));
  },
);
