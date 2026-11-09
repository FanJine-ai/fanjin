import express from "express";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";
import { z } from "zod";
import {
  deletionWorkflowHttpError,
  requestAssetDeletion,
} from "@/lib/deletionWorkflow";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 批量删除资产
export default router.post(
  "/",
  requireActiveWorkspacePermission("project:delete"),  validateFields({
    id: z.array(z.number().int().positive()).max(100).optional(),
    ids: z.array(z.number().int().positive()).max(100).optional(),
  }),
  async (req, res) => {
    const rawIds = Array.isArray(req.body.ids)
      ? req.body.ids
      : Array.isArray(req.body.id)
      ? req.body.id
      : [];
    const ids: number[] = [
      ...new Set<number>(
        rawIds.map((value: unknown) => Number(value)),
      ),
    ];
    if (!ids.length || ids.length > 100) {
      return res.status(400).send(
        error("资产 ids 必须包含 1 到 100 个正整数", {
          code: "DELETION_INPUT_INVALID",
        }),
      );
    }
    const user = (req as any).auth?.user || {};
    const results = [];
    for (const assetId of ids) {
      try {
        const operation = await requestAssetDeletion({
          assetId,
          userId: Number(user.id || 0),
          role: user.role,
          authWorkspaceId: (req as any).auth?.workspaceId,
        });
        results.push({
          id: assetId,
          status: "accepted",
          operation,
        });
      } catch (workflowError) {
        const failure = deletionWorkflowHttpError(workflowError);
        results.push({
          id: assetId,
          status: "rejected",
          code: failure.code,
          httpStatus: failure.status,
          message: failure.status === 404
            ? "资产不存在或无权访问"
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
    }, "批量资产删除请求已处理"));
  },
);
