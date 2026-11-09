import express from "express";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";
import type { Knex } from "knex";
import { z } from "zod";
import {
  deletionWorkflowHttpError,
  requestAssetDeletion,
  type DeletionWorkflowRuntime,
} from "@/lib/deletionWorkflow";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { db as knexDb } from "@/utils/db";

export interface AssetDeleteRouteDependencies {
  database?: Knex;
  workflowRuntime?: Omit<DeletionWorkflowRuntime, "database">;
}

export function createAssetDeleteRouter(
  dependencies: AssetDeleteRouteDependencies = {},
) {
  const router = express.Router();
  const database = dependencies.database ?? knexDb;
  return router.post(
    "/",
  requireActiveWorkspacePermission("project:delete"),    validateFields({
      id: z.number().int().positive(),
    }),
    async (req, res) => {
      const user = (req as any).auth?.user || {};
      try {
        const operation = await requestAssetDeletion({
          assetId: Number(req.body.id),
          userId: Number(user.id || 0),
          role: user.role,
          authWorkspaceId: (req as any).auth?.workspaceId,
        }, {
          ...dependencies.workflowRuntime,
          database,
        });
        return res.status(202).send(
          success({ operation }, "资产删除请求已受理"),
        );
      } catch (workflowError) {
        const failure = deletionWorkflowHttpError(workflowError);
        return res.status(failure.status).send(
          error(failure.message, { code: failure.code }),
        );
      }
    },
  );
}

export default createAssetDeleteRouter();
