import express from "express";

import { requireProjectPermission } from "@/middleware/projectAccess";
import { createLegacyPaidCreationGoneHandler } from "@/lib/legacyPaidCreationGone";

const router = express.Router();

export default router.post(
  "/",
  requireProjectPermission("generation:create"),
  createLegacyPaidCreationGoneHandler({
    route: "/api/assetsGenerate/generateAssets",
    endpoint: "/api/workbench/create/images",
    requiredHeader: "Idempotency-Key",
    guidance: "请由资产库使用 projectId 与 targetAssetId 提交可恢复的图片任务。",
  }),
);
