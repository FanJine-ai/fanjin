import express from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";
import { insertAndReturnId } from "@/lib/dbDialect";
import { DurableCommandIdempotencyError } from "@/lib/durableCommandIdempotency";
import { executeDurableProjectMutation } from "@/lib/durableProjectMutation";
import { registerAccountOwnedAssetIfAvailable } from "@/lib/accountWorkspaceAssetLibrary";
const router = express.Router();

// 新增资产
export default router.post(
  "/",
  requireProjectPermission("project:write"),
  validateFields({
    name: z.string(),
    describe: z.string(),
    type: z.string(),
    projectId: z.number(),
    remark: z.string().optional().nullable(),
    prompt: z.string().optional().nullable(),
  }),
  async (req, res) => {
    const { name, describe, type, projectId, remark, prompt } = req.body;
    try {
      const result = await executeDurableProjectMutation({
        req,
        scope: "asset:add",
        request: { name, describe, type, projectId, remark, prompt },
        mutate: async (transaction) => {
          const id = await insertAndReturnId(transaction, "o_assets", {
            name,
            describe,
            type,
            projectId,
            remark,
            prompt,
            startTime: Date.now(),
          });
          const actorUserId = Number((req as any).auth?.user?.id || (req as any).user?.id || 0);
          const workspaceId = String((req as any).auth?.workspaceId || (req as any).project?.workspaceId || "");
          if (actorUserId > 0 && workspaceId) {
            await registerAccountOwnedAssetIfAvailable({
              transaction,
              assetId: Number(id),
              projectId,
              workspaceId,
              actorUserId,
              idempotencyKey: `${String(req.get("Idempotency-Key") || "asset-add")}:${id}:ownership`,
            });
          }
          return { id, message: "新增资产成功" };
        },
      });
      return res
        .status(result.responseStatus)
        .send(success(result.data));
    } catch (error) {
      if (error instanceof DurableCommandIdempotencyError) {
        return res.status(error.status).send({
          message: error.message,
          code: error.code,
        });
      }
      throw error;
    }
  },
);
