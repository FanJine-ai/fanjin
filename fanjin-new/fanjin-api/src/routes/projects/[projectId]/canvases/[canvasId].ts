import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { renameCanonicalCanvas } from "@/lib/projectCanvasService";
import { requireProjectPermission } from "@/middleware/projectAccess";
import { validateFields } from "@/middleware/middleware";

const router = express.Router({ mergeParams: true });
const expectedRevisionSchema = z.union([
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  z.string()
    .regex(/^[1-9]\d*$/)
    .refine((value) => Number.isSafeInteger(Number(value)), "必须是正安全整数"),
]);

router.patch(
  "/",
  requireProjectPermission("project:write"),
  validateFields({
    name: z.string().trim().min(1).max(200),
    expectedRevision: expectedRevisionSchema.optional().nullable(),
  }),
  async (req, res) => {
    const projectId = Number(req.params.projectId);
    const canvasId = Number(req.params.canvasId);
    const renamed = await renameCanonicalCanvas(
      projectId,
      canvasId,
      req.body.name,
      req.body.expectedRevision == null ? null : Number(req.body.expectedRevision),
    );
    if (!renamed) return res.status(404).send({ message: "画布不存在" });
    if (renamed.kind === "conflict") {
      return res.status(409).send({
        code: 409,
        message: "画布已被其他请求更新，请重新加载后再重命名",
        data: {
          expectedRevision: renamed.expectedRevision,
          currentRevision: renamed.currentRevision,
        },
      });
    }
    return res.status(200).send(success({
      success: true,
      canvasId: renamed.canvasId,
      revision: renamed.revision,
    }));
  },
);

export default router;
