import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import {
  createProjectCanvas,
  listProjectCanvases,
} from "@/lib/projectCanvasService";
import { requireProjectPermission } from "@/middleware/projectAccess";
import { validateFields } from "@/middleware/middleware";

const router = express.Router({ mergeParams: true });

router.get(
  "/",
  requireProjectPermission("project:read"),
  async (req, res) => {
    const projectId = Number(req.params.projectId);
    const canvases = await listProjectCanvases(projectId);
    return res.status(200).send(success({ canvases }));
  },
);

router.post(
  "/",
  requireProjectPermission("project:write"),
  validateFields({ name: z.string().trim().min(1).max(200).optional() }),
  async (req, res) => {
    const projectId = Number(req.params.projectId);
    const created = await createProjectCanvas(projectId, req.body?.name);
    return res.status(201).send(success(created));
  },
);

export default router;
