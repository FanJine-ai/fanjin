import express from "express";

import {
  findInspirationWorkspaceProject,
  listInspirationWorkspaceReferences,
} from "@/lib/inspirationWorkspaceProject";
import { success } from "@/lib/responseFormat";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";
import { db } from "@/utils/db";

const router = express.Router();

export default router.get(
  "/",
  requireActiveWorkspacePermission("project:read"),
  async (req, res) => {
    const workspaceId = String((req as any).auth?.workspaceId || "").trim();
    const userId = Number((req as any).auth?.user?.id || 0);
    if (!workspaceId || !Number.isSafeInteger(userId) || userId <= 0) {
      return res.status(403).send({ message: "缺少工作区上下文" });
    }

    const project = await findInspirationWorkspaceProject({
      database: db,
      workspaceId,
      userId,
    });
    if (!project) {
      return res.status(200).send(success({ projectId: null, references: [] }));
    }
    const references = await listInspirationWorkspaceReferences({
      database: db,
      workspaceId,
      userId,
      projectId: project.id,
    });
    return res.status(200).send(success({ projectId: project.id, references }));
  },
);
