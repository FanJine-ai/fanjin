import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import {
  createCanonicalProject,
  listCanonicalProjects,
} from "@/lib/projectCanvasService";
import { validateFields } from "@/middleware/middleware";
import {
  requireActiveWorkspacePermission,
} from "@/middleware/permissions";
import { db } from "@/utils/db";
import {
  publicProjectCorrelationDigest,
  readPublicCreationTokenKey,
} from "@/lib/publicCreationObservability";

const router = express.Router();

router.get(
  "/",
  requireActiveWorkspacePermission("project:read"),
  async (req, res) => {
    const workspaceId = String((req as any).auth?.workspaceId || "");
    const projects = await listCanonicalProjects(workspaceId);
    const tokenKey = await readPublicCreationTokenKey(db);
    return res.status(200).send(success({
      projects: projects.map((project) => ({
        ...project,
        correlationDigest: publicProjectCorrelationDigest({
          tokenKey,
          workspaceId,
          projectId: project.projectId,
        }),
      })),
    }));
  },
);

router.post(
  "/",
  requireActiveWorkspacePermission("project:write"),
  validateFields({ name: z.string().trim().min(1).max(200).optional() }),
  async (req, res) => {
    const workspaceId = String((req as any).auth?.workspaceId || "");
    const userId = Number((req as any).auth?.user?.id || 0);
    const created = await createCanonicalProject({
      workspaceId,
      userId,
      name: req.body?.name,
    });
    return res.status(201).send(success(created));
  },
);

export default router;
