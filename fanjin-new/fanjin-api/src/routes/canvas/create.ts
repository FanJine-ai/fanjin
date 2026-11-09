import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import {
  createCanonicalProject,
  createProjectCanvas,
} from "@/lib/projectCanvasService";
import { checkProjectPermission } from "@/middleware/projectAccess";
import { validateFields } from "@/middleware/middleware";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";

const router = express.Router();

router.post(
  "/",
  requireActiveWorkspacePermission("project:write"),
  validateFields({
    name: z.string().trim().min(1).max(200).optional(),
    projectId: z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)]).optional(),
  }),
  async (req, res) => {
    const requestedProjectId = Number(req.body?.projectId || 0);
    if (requestedProjectId) {
      const user = (req as any).auth?.user || {};
      const access = await checkProjectPermission({
        projectId: requestedProjectId,
        userId: Number(user.id || 0),
        role: user.role,
        permission: "project:write",
        authWorkspaceId: (req as any).auth?.workspaceId,
      });
      if (!access.allowed) return res.status(access.status).send({ message: access.message });
      const created = await createProjectCanvas(requestedProjectId, req.body?.name);
      return res.status(201).send(success(created));
    }

    const created = await createCanonicalProject({
      workspaceId: String((req as any).auth?.workspaceId || ""),
      userId: Number((req as any).auth?.user?.id || 0),
      name: req.body?.name || "未命名项目",
    });
    return res.status(201).send(success({
      canvasId: created.defaultCanvasId,
      projectId: created.projectId,
    }));
  },
);

export default router;
