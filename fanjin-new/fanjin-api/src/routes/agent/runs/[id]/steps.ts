import express from "express";
import { z } from "zod";
import { toAgentStepDto } from "@/agent-runtime/dto";
import { requireAgentRuntimePreview } from "@/agent-runtime/featureFlags";
import { assertAgentProjectAccess, getAgentRequestActor } from "@/agent-runtime/httpAccess";
import { agentSuccess, requireResource, sendAgentRuntimeError } from "@/agent-runtime/http";
import { getAgentRun, listAgentSteps } from "@/agent-runtime/repository";

const router = express.Router({ mergeParams: true });
router.use(requireAgentRuntimePreview);

export const listSchema = z.object({
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
}).strict();

router.get("/", async (req, res) => {
  try {
    const parsed = listSchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return res.status(400).send({ code: "invalid_request", message: "参数错误", errors: parsed.error.issues });
    }
    const actor = getAgentRequestActor(req);
    const run = requireResource(
      await getAgentRun({ id: String((req.params as any).id || ""), workspaceId: actor.workspaceId }),
      "run_not_found",
      "Agent Run 不存在",
    );
    await assertAgentProjectAccess(req, run.projectId, "project:read");
    const page = await listAgentSteps({
      runId: run.id,
      workspaceId: actor.workspaceId,
      after: parsed.data.after,
      limit: parsed.data.limit,
    });
    return res.status(200).send(agentSuccess({
      data: page.data.map(toAgentStepDto),
      nextCursor: page.nextCursor,
    }));
  } catch (error) {
    return sendAgentRuntimeError(res, error);
  }
});

export default router;
