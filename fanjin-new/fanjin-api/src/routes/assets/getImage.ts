import express from "express";
import u from "@/utils";
import { error, success } from "@/lib/responseFormat";
import { z } from "zod";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 获取生成图片
export default router.post(
  "/",
  validateFields({
    assetsId: z.number(),
  }),
  async (req, res) => {
    const { assetsId } = req.body;

    const assets = await u.db("o_assets")
      .where({ id: assetsId, deletionState: "active" })
      .select("id", "imageId", "type")
      .first();
    if (!assets) {
      return res.status(404).send(error("资产不存在"));
    }

    const rawTempAssets = await u.db("o_image")
      .where({ assetsId, deletionState: "active" })
      .select("id", "filePath", "assetsId", "type", "state");
    const selectedImageId = rawTempAssets.some(
      (item: any) => Number(item.id) === Number(assets.imageId),
    )
      ? assets.imageId
      : null;

    const tempAssets = await Promise.all(
      rawTempAssets.map(async (item) => ({
        ...item,
        filePath: item.filePath ? await u.oss.getSmallImageUrl(item.filePath) : "",
        selected: selectedImageId != null && Number(item.id) === Number(selectedImageId),
      })),
    );

    const data = {
      id: assets.id,
      imageId: selectedImageId,
      tempAssets,
    };
    return res.status(200).send(success(data));
  },
);
