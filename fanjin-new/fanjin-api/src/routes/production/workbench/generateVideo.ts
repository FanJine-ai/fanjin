import express from "express";

import { requireProjectPermission } from "@/middleware/projectAccess";
import { sendLegacyProductionGenerationGone } from "@/lib/legacyProductionGenerationGone";

const router = express.Router();

export default router.post(
  "/",
  requireProjectPermission("generation:create"),
  sendLegacyProductionGenerationGone,
);
