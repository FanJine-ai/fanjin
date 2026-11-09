import express from "express";
import { z } from "zod";
import { createLegacyPaidCreationGoneHandler } from "@/lib/legacyPaidCreationGone";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";
const router = express.Router();

export default router.post(
  "/",
  requireProjectPermission("project:read"),
  validateFields({
    projectId: z.number().int().positive(),
    ids: z.array(z.number().int().positive()),
  }),
  createLegacyPaidCreationGoneHandler({
    route: "/api/script/pollScriptAssets",
    endpoint: "/api/script/extractAssets",
    requiredHeader: "Idempotency-Key",
    guidance: "旧版后台轮询已停用；请使用同步、可恢复的剧本资产提案与确认流程。",
  }),
);
