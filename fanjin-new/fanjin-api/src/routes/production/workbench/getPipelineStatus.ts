import express from "express";
import { z } from "zod";

import { readShortDramaPipeline } from "@/lib/shortDramaPipelineStatus";
import { success } from "@/lib/responseFormat";
import { requireProjectPermission } from "@/middleware/projectAccess";
import { validateFields } from "@/middleware/middleware";
import { db } from "@/utils/db";

const router = express.Router();

export default router.post(
  "/",
  validateFields({ projectId: z.number().int().positive() }),
  requireProjectPermission("project:read"),
  async (req, res) => {
    const workspaceId = String((req as any).auth?.workspaceId || "").trim();
    const data = await readShortDramaPipeline({ database: db, workspaceId, projectId: req.body.projectId });
    return res.status(200).send(success(data));
  },
);
