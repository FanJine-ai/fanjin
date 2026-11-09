import express from "express";

import { requireProjectPermission } from "@/middleware/projectAccess";
import { createLegacyPaidCreationGoneHandler } from "@/lib/legacyPaidCreationGone";

const router = express.Router();

export default router.post(
  "/",
  requireProjectPermission("project:write"),
  createLegacyPaidCreationGoneHandler({
    route: "/api/cornerScape/batchBindAudio",
    endpoint: "/api/assets/updateAudioAssets",
    guidance: "自动配音能力当前未开放；请在资产库中人工维护受控音频资产。",
  }),
);
