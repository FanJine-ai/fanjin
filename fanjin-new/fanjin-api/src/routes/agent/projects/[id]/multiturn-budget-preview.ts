import express from "express";
import { z } from "zod";

import { AgentRuntimeError } from "@/agent-runtime/errors";
import { requireAgentRuntimePreview } from "@/agent-runtime/featureFlags";
import { agentSuccess, sendAgentRuntimeError } from "@/agent-runtime/http";
import { assertAgentProjectAccess } from "@/agent-runtime/httpAccess";
import {
  AGENT_MULTITURN_BUDGET_PREVIEW_VERSION,
  resolveAgentMultiturnBudgetPreview,
} from "@/agent-runtime/multiturnBudgetPreview";

const router = express.Router({ mergeParams: true });
router.use(requireAgentRuntimePreview);

export const agentMultiturnBudgetPreviewBodySchema = z.object({
  version: z.literal(AGENT_MULTITURN_BUDGET_PREVIEW_VERSION),
  chatModelId: z.string().trim().min(1).max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
}).strict();

function projectIdFromRequest(req: express.Request): number {
  const projectId = Number((req.params as Record<string, unknown>).id);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new AgentRuntimeError(
      400,
      "agent_multiturn_budget_project_id_invalid",
      "项目 ID 无效",
    );
  }
  return projectId;
}

router.post("/", async (req, res) => {
  try {
    const parsed = agentMultiturnBudgetPreviewBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).send({
        code: "invalid_request",
        message: "参数错误",
        errors: parsed.error.issues,
      });
    }
    const projectId = projectIdFromRequest(req);
    const { actor } = await assertAgentProjectAccess(
      req,
      projectId,
      "project:write",
    );
    const preview = await resolveAgentMultiturnBudgetPreview({
      workspaceId: actor.workspaceId,
      chatModelId: parsed.data.chatModelId,
    });
    return res.status(200).send(agentSuccess(preview));
  } catch (error) {
    return sendAgentRuntimeError(res, error);
  }
});

export default router;
