import express from "express";

import { requireProjectPermission } from "@/middleware/projectAccess";
import { createLegacyPaidCreationGoneHandler } from "@/lib/legacyPaidCreationGone";

const router = express.Router();

export default router.post(
  "/",
  requireProjectPermission("generation:create"),
  createLegacyPaidCreationGoneHandler({
    route: "/api/production/editImage/generateFlowImage",
    endpoint: "/api/workbench/create/images",
    requiredHeader: "Idempotency-Key",
    guidance: "请先将参考图保存到项目受控存储，再以 assetVersionId 提交可恢复的图片任务。",
  }),
);
