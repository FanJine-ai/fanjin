import express from "express";
import { z } from "zod";
import { DurableCommandIdempotencyError } from "@/lib/durableCommandIdempotency";
import { executeDurableProjectMutation } from "@/lib/durableProjectMutation";
import {
  deleteStoryboardsInTransaction,
  ProductionDeletionError,
} from "@/lib/productionDeletion";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireIdempotencyKey } from "@/middleware/idempotencyKey";
import { requireProjectPermission } from "@/middleware/projectAccess";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    ids: z.array(z.number().int().positive()).min(1).max(100),
    projectId: z.number().int().positive(),
  }),
  requireProjectPermission("project:write"),
  requireIdempotencyKey,
  async (req, res) => {
    const projectId = Number(req.body.projectId);
    const ids = [...new Set<number>(req.body.ids.map(Number))]
      .sort((left, right) => left - right);
    const workspaceId = String((req as any).project?.workspaceId || "").trim();
    try {
      const result = await executeDurableProjectMutation({
        req,
        scope: "production:delete:storyboards",
        request: { projectId, ids },
        mutate: (transaction) => deleteStoryboardsInTransaction(transaction, {
          workspaceId,
          projectId,
          storyboardIds: ids,
        }),
      });
      return res.status(result.responseStatus).send(success(result.data));
    } catch (error) {
      if (
        error instanceof DurableCommandIdempotencyError
        || error instanceof ProductionDeletionError
      ) {
        return res.status(error.status).send({
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  },
);
