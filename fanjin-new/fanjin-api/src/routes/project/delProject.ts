import express from "express";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import {
  deletionWorkflowHttpError,
  requestProjectDeletion,
} from "@/lib/deletionWorkflow";
import { db as knexDb } from "@/utils/db";
const router = express.Router();

// 删除项目
export default router.post(
  "/",
  requireActiveWorkspacePermission("project:delete"),  validateFields({
    id: z.number(),
  }),
  async (req, res) => {
    const { id } = req.body;
    const user = (req as any).auth?.user || {};
    try {
      const operation = await requestProjectDeletion({
        projectId: id,
        userId: Number(user.id || 0),
        role: user.role,
        authWorkspaceId: (req as any).auth?.workspaceId,
      }, { database: knexDb });
      return res.status(202).send(success({ operation }, "项目删除请求已受理"));
    } catch (workflowError) {
      const failure = deletionWorkflowHttpError(workflowError);
      return res.status(failure.status).send(
        error(failure.message, { code: failure.code }),
      );
    }
  },
);
