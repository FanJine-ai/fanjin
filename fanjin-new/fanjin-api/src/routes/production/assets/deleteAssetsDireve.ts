import express from "express";
import { z } from "zod";
import {
  deletionWorkflowHttpError,
  requestAssetDeletion,
} from "@/lib/deletionWorkflow";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.number().int().positive(),
    projectId: z.number().int().positive().optional(),
  }),
  async (req, res) => {
    const user = (req as any).auth?.user || {};
    try {
      // projectId in the legacy request body is deliberately ignored. The
      // workflow resolves asset -> project -> workspace from locked rows.
      const operation = await requestAssetDeletion({
        assetId: Number(req.body.id),
        userId: Number(user.id || 0),
        role: user.role,
        authWorkspaceId: (req as any).auth?.workspaceId,
      });
      return res.status(202).send(
        success({ operation }, "生产资产删除请求已受理"),
      );
    } catch (workflowError) {
      const failure = deletionWorkflowHttpError(workflowError);
      return res.status(failure.status).send(
        error(failure.message, { code: failure.code }),
      );
    }
  },
);
