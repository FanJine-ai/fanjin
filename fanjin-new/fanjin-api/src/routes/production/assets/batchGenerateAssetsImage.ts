import express from "express";

import { requireProjectPermission } from "@/middleware/projectAccess";
import { createLegacyPaidCreationGoneHandler } from "@/lib/legacyPaidCreationGone";

const router = express.Router();

export default router.post(
  "/",
  requireProjectPermission("generation:create"),
  createLegacyPaidCreationGoneHandler({
    route: "/api/production/assets/batchGenerateAssetsImage",
    endpoint: "/api/workbench/create/images",
    requiredHeader: "Idempotency-Key",
    guidance: "请由资产库逐项提交 targetAssetId；当前入口会保存任务并支持安全恢复。",
  }),
);
