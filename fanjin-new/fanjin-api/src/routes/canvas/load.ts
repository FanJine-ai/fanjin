import express from "express";
import { success } from "@/lib/responseFormat";
import {
  getCanvasOwner,
  loadCanonicalCanvas,
} from "@/lib/projectCanvasService";
import { checkProjectPermission } from "@/middleware/projectAccess";

const router = express.Router();

router.get("/", async (req, res) => {
  const canvasId = Number(req.query.canvasId || 0);
  if (!Number.isSafeInteger(canvasId) || canvasId <= 0) {
    return res.status(400).send({ message: "无效的 canvasId" });
  }
  const owner = await getCanvasOwner(canvasId);
  if (!owner) return res.status(404).send({ message: "画布不存在" });
  const user = (req as any).auth?.user || {};
  const access = await checkProjectPermission({
    projectId: Number(owner.projectId),
    userId: Number(user.id || 0),
    role: user.role,
    permission: "project:read",
    authWorkspaceId: (req as any).auth?.workspaceId,
  });
  if (!access.allowed) return res.status(access.status).send({ message: access.message });
  const canvas = await loadCanonicalCanvas(canvasId);
  if (!canvas) return res.status(404).send({ message: "画布不存在" });
  return res.status(200).send(success(canvas));
});

export default router;
