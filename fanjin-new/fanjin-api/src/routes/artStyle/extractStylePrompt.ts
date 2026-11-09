import express from "express";

import { requireActiveWorkspacePermission } from "@/middleware/permissions";
import { createLegacyPaidCreationGoneHandler } from "@/lib/legacyPaidCreationGone";

const router = express.Router();

export default router.post(
  "/",
  requireActiveWorkspacePermission("generation:create"),
  createLegacyPaidCreationGoneHandler({
    route: "/api/artStyle/extractStylePrompt",
    endpoint: "/api/workbench/create/directorPlan",
    requiredHeader: "Idempotency-Key",
    guidance: "请在创作台导演规划中提交并保存视觉风格。",
  }),
);
