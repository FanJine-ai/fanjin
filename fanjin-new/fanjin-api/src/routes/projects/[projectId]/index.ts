import express from "express";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import {
  updateCanonicalProject,
} from "@/lib/projectCanvasService";
import {
  deletionWorkflowHttpError,
  requestProjectDeletion,
} from "@/lib/deletionWorkflow";
import { requireProjectPermission } from "@/middleware/projectAccess";
import { validateFields } from "@/middleware/middleware";

const router = express.Router({ mergeParams: true });

router.patch(
  "/",
  requireProjectPermission("project:write"),
  validateFields({
    name: z.string().trim().min(1).max(200).optional(),
    coverImageUrl: z.string().max(4_000_000).optional(),
  }),
  async (req, res) => {
    const projectId = Number(req.params.projectId);
    const updated = await updateCanonicalProject(projectId, {
      name: req.body?.name,
      coverImageUrl: req.body?.coverImageUrl,
    });
    if (!updated) return res.status(404).send({ message: "项目不存在" });
    return res.status(200).send(success({ success: true }));
  },
);

router.delete(
  "/",
  requireProjectPermission("project:delete"),
  async (req, res) => {
    const projectId = Number((req.params as any).projectId);
    const user = (req as any).auth?.user || {};
    try {
      const operation = await requestProjectDeletion({
        projectId,
        userId: Number(user.id || 0),
        role: user.role,
        authWorkspaceId: (req as any).auth?.workspaceId,
      });
      return res.status(202).send(success({ operation }, "项目删除请求已受理"));
    } catch (workflowError) {
      const failure = deletionWorkflowHttpError(workflowError);
      return res.status(failure.status).send(
        error(failure.message, { code: failure.code }),
      );
    }
  },
);

export default router;
