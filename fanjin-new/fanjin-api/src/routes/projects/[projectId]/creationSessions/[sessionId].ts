import express from "express";
import { z } from "zod";
import { assertAgentProjectAccess } from "@/agent-runtime/httpAccess";
import { agentSuccess, sendAgentRuntimeError } from "@/agent-runtime/http";
import { toCreationSessionDto, updateCreationSession } from "@/lib/creationSessionService";

const router = express.Router({ mergeParams: true });
const paramsSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  sessionId: z.string().trim().min(1).max(200),
});
export const updateSchema = z.object({
  expectedVersion: z.number().int().positive(),
  goal: z.string().trim().max(20_000).optional(),
  mode: z.enum(["agent", "quick_create", "canvas"]).optional(),
  inputs: z.array(z.unknown()).max(100).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  selectedAssetVersionIds: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
  canvasId: z.string().trim().min(1).max(200).optional().nullable(),
});

router.put("/", async (req, res) => {
  try {
    const params = paramsSchema.safeParse(req.params);
    const body = updateSchema.safeParse(req.body ?? {});
    if (!params.success || !body.success) {
      return res.status(400).send({ code: "invalid_request", message: "参数错误" });
    }
    const access = await assertAgentProjectAccess(req, params.data.projectId, "project:write");
    const session = await updateCreationSession({
      id: params.data.sessionId,
      workspaceId: access.workspaceId,
      projectId: params.data.projectId,
      expectedVersion: body.data.expectedVersion,
      draft: {
        goal: body.data.goal,
        mode: body.data.mode,
        inputs: body.data.inputs,
        parameters: body.data.parameters,
        selectedAssetVersionIds: body.data.selectedAssetVersionIds,
        canvasId: body.data.canvasId,
      },
    });
    return res.status(200).send(agentSuccess(toCreationSessionDto(session)));
  } catch (error) {
    return sendAgentRuntimeError(res, error);
  }
});

export default router;
