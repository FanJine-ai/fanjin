import express from "express";

import {
  deletionWorkflowHttpError,
  getAuthorizedDeletionOperation,
} from "@/lib/deletionWorkflow";
import { error, success } from "@/lib/responseFormat";

const router = express.Router({ mergeParams: true });

export default router.get("/", async (req, res) => {
  const user = (req as any).auth?.user || {};
  try {
    const operation = await getAuthorizedDeletionOperation({
      operationId: String((req.params as any).operationId || ""),
      userId: Number(user.id || 0),
      role: user.role,
      authWorkspaceId: (req as any).auth?.workspaceId,
    });
    return res.status(200).send(success({ operation }));
  } catch (workflowError) {
    const failure = deletionWorkflowHttpError(workflowError);
    return res.status(failure.status).send(
      error(failure.message, { code: failure.code }),
    );
  }
});
