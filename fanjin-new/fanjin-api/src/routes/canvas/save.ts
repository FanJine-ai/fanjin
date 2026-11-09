import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import {
  getCanvasOwner,
  saveCanonicalCanvas,
} from "@/lib/projectCanvasService";
import { checkProjectPermission } from "@/middleware/projectAccess";
import { validateFields } from "@/middleware/middleware";

const router = express.Router();
const expectedRevisionSchema = z.union([
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  z.string()
    .regex(/^[1-9]\d*$/)
    .refine((value) => Number.isSafeInteger(Number(value)), "必须是正安全整数"),
]);

router.post(
  "/",
  validateFields({
    canvasId: z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)]),
    projectId: z.union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)]).optional().nullable(),
    expectedRevision: expectedRevisionSchema.optional().nullable(),
    name: z.string().max(200).optional(),
    canvasName: z.string().max(200).optional(),
    coverImageUrl: z.string().max(4_000_000).optional(),
    coverUrl: z.string().max(4_000_000).optional(),
    nodes: z.array(z.any()).optional(),
    edges: z.array(z.any()).optional(),
    connections: z.array(z.any()).optional(),
    groups: z.array(z.any()).optional(),
    viewport: z.record(z.string(), z.any()).optional(),
  }),
  async (req, res) => {
    const canvasId = Number(req.body.canvasId);
    const owner = await getCanvasOwner(canvasId);
    if (!owner) return res.status(404).send({ message: "画布不存在" });
    const user = (req as any).auth?.user || {};
    const access = await checkProjectPermission({
      projectId: Number(owner.projectId),
      userId: Number(user.id || 0),
      role: user.role,
      permission: "project:write",
      authWorkspaceId: (req as any).auth?.workspaceId,
    });
    if (!access.allowed) return res.status(access.status).send({ message: access.message });
    const saved = await saveCanonicalCanvas({
      canvasId,
      projectId: req.body.projectId == null ? null : Number(req.body.projectId),
      expectedRevision: req.body.expectedRevision == null ? null : Number(req.body.expectedRevision),
      name: req.body.name || req.body.canvasName,
      coverImageUrl: req.body.coverImageUrl || req.body.coverUrl,
      nodes: req.body.nodes,
      edges: req.body.edges,
      connections: req.body.connections,
      groups: req.body.groups,
      viewport: req.body.viewport,
    });
    if (!saved) return res.status(404).send({ message: "画布与项目不匹配" });
    if (saved.kind === "conflict") {
      return res.status(409).send({
        code: 409,
        message: "画布已被其他请求更新，请重新加载后再保存",
        data: {
          expectedRevision: saved.expectedRevision,
          currentRevision: saved.currentRevision,
        },
      });
    }
    return res.status(200).send(success({
      canvasId: saved.canvasId,
      revision: saved.revision,
    }));
  },
);

export default router;
