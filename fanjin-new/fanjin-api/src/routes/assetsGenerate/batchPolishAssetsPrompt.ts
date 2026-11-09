import express from "express";

import { requireProjectPermission } from "@/middleware/projectAccess";
import { createLegacyPaidCreationGoneHandler } from "@/lib/legacyPaidCreationGone";

const router = express.Router();

export default router.post(
  "/",
  requireProjectPermission("generation:create"),
  createLegacyPaidCreationGoneHandler({
    route: "/api/assetsGenerate/batchPolishAssetsPrompt",
    endpoint: "/api/assetsGenerate/polishAssetsPrompt",
    requiredHeader: "Idempotency-Key",
    guidance: "请由资产库逐项调用可恢复的单资产提示词生成入口。",
  }),
);
