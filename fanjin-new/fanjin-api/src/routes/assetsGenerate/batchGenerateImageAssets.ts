import express from "express";

import { requireProjectPermission } from "@/middleware/projectAccess";
import { createLegacyPaidCreationGoneHandler } from "@/lib/legacyPaidCreationGone";

const router = express.Router();

export default router.post(
  "/",
  requireProjectPermission("generation:create"),
  createLegacyPaidCreationGoneHandler({
    route: "/api/assetsGenerate/batchGenerateImageAssets",
    endpoint: "/api/workbench/create/images",
    requiredHeader: "Idempotency-Key",
    guidance: "请由资产库逐项提交 targetAssetId，并为每次真实生成使用稳定请求键。",
  }),
);
