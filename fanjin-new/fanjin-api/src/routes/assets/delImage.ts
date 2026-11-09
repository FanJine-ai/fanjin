import express from "express";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import {
  deletionWorkflowHttpError,
  requestImageDeletion,
} from "@/lib/deletionWorkflow";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

export default router.post(
  "/",
  requireActiveWorkspacePermission("project:delete"),  validateFields({
    id: z.number(),
  }),
  async (req, res) => {
    const { id } = req.body;
    const user = (req as any).auth?.user || {};
    try {
      const operation = await requestImageDeletion({
        imageId: id,
        userId: Number(user.id || 0),
        role: user.role,
        authWorkspaceId: (req as any).auth?.workspaceId,
      });
      return res.status(202).send(success({ operation }, "图片删除请求已受理"));
    } catch (workflowError) {
      const failure = deletionWorkflowHttpError(workflowError);
      return res.status(failure.status).send(
        error(failure.message, { code: failure.code }),
      );
    }
  },
);
