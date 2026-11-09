import express from "express";
import { success } from "@/lib/responseFormat";
import { listWorkspaceCanvases } from "@/lib/projectCanvasService";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";

const router = express.Router();

router.get(
  "/",
  requireActiveWorkspacePermission("project:read"),
  async (req, res) => {
    const canvases = await listWorkspaceCanvases(String((req as any).auth?.workspaceId || ""));
    return res.status(200).send(success(canvases));
  },
);

export default router;
