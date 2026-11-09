import express from "express";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";
import { z } from "zod";
import {
  deletionWorkflowHttpError,
  requestMediaAssetDeletion,
} from "@/lib/deletionWorkflow";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { checkProjectPermission } from "@/middleware/projectAccess";
import { db } from "@/utils/db";

const router = express.Router();

export default router.post(
  "/",
  requireActiveWorkspacePermission("project:delete"),  validateFields({
    ids: z.array(z.string().uuid()).min(1).max(100),
  }),
  async (req, res) => {
    const ids = [...new Set(
      (req.body.ids as string[]).map((id) => id.toLowerCase()),
    )];
    const user = (req as any).auth?.user || {};
    const results = [];
    for (const mediaAssetId of ids) {
      try {
        const operation = await requestMediaAssetDeletion({
          mediaAssetId,
          userId: Number(user.id || 0),
          role: user.role,
          authWorkspaceId: (req as any).auth?.workspaceId,
        }, {
          database: db,
          authorizeProject: checkProjectPermission,
        });
        results.push({
          id: mediaAssetId,
          status: "accepted",
          operation,
        });
      } catch (workflowError) {
        const failure = deletionWorkflowHttpError(workflowError);
        results.push({
          id: mediaAssetId,
          status: "rejected",
          code: failure.code,
          httpStatus: failure.status,
          message: failure.status === 404
            ? "媒体不存在或无权访问"
            : failure.message,
        });
      }
    }
    const accepted = results.filter((item) =>
      item.status === "accepted").length;
    return res.status(202).send(success({
      requested: ids.length,
      accepted,
      rejected: ids.length - accepted,
      results,
    }, "创作库删除请求已处理"));
  },
);
