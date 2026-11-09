import express from "express";
import { db } from "@/utils/db";
import { error, success } from "@/lib/responseFormat";
import { requirePlatformAdmin } from "@/middleware/permissions";
import {
  INTERNAL_VIDEO_RESOLUTIONS,
  isPublicVideoResolution,
  normalizeVideoResolution,
  PUBLIC_VIDEO_RESOLUTIONS,
} from "@/lib/videoResolutions";
import {
  listAdminOffers,
  listAdminRecipes,
  listEnhanceOverview,
  listVideoChannels,
} from "@/lib/videoFulfillment/adminService";

/**
 * M2 视频能力兑现 admin 只读端点。
 * 写操作在同级独立文件(offersUpdate/recipesCreate/recipesUpdate/recipesDelete/
 * enhancePricingUpdate),与 step-up scope 一一对应。
 */
const router = express.Router();
router.use(requirePlatformAdmin);

router.get("/meta", async (_req, res) => {
  return res.status(200).send(
    success({
      publicResolutions: PUBLIC_VIDEO_RESOLUTIONS,
      internalResolutions: INTERNAL_VIDEO_RESOLUTIONS,
      notes: {
        noPublic480: true,
        workbenchEnhance: "separate_billing",
        relayEnhance: "forbidden",
        // Runtime reads o_model_route.displayName; offer.displayName is a write-through mirror.
        displayNameSource: "model_route",
        displayNameMirror: "video_public_offer",
      },
    }),
  );
});

router.get("/offers", async (_req, res) => {
  try {
    const offers = await listAdminOffers(db as any);
    return res.status(200).send(success({ offers }));
  } catch (err: any) {
    return res.status(500).send(error(err?.message || "读取公开能力失败"));
  }
});

router.get("/recipes", async (req, res) => {
  try {
    const publicModel = String(req.query.publicModel || "").trim();
    const targetResolution = normalizeVideoResolution(req.query.targetResolution);
    if (!publicModel) return res.status(400).send(error("缺少 publicModel"));
    if (!targetResolution || !isPublicVideoResolution(targetResolution)) {
      return res.status(400).send(error("目标分辨率须为 720p/1080p/2k/4k"));
    }
    const recipes = await listAdminRecipes(db as any, { publicModel, targetResolution });
    return res.status(200).send(success({ recipes }));
  } catch (err: any) {
    return res.status(500).send(error(err?.message || "读取配方失败"));
  }
});

router.get("/channels", async (_req, res) => {
  try {
    const channels = await listVideoChannels(db as any);
    return res.status(200).send(success({ channels }));
  } catch (err: any) {
    return res.status(500).send(error(err?.message || "读取通道失败"));
  }
});

router.get("/enhance/overview", async (_req, res) => {
  try {
    const overview = await listEnhanceOverview(db as any);
    return res.status(200).send(success(overview));
  } catch (err: any) {
    return res.status(500).send(error(err?.message || "读取画质增强配置失败"));
  }
});

export default router;
