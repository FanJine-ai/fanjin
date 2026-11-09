import express from "express";
import { z } from "zod";
import { toAgentRunDto } from "@/agent-runtime/dto";
import { requireAgentRuntimePreview } from "@/agent-runtime/featureFlags";
import { assertAgentProjectAccess, getAgentRequestActor } from "@/agent-runtime/httpAccess";
import { agentSuccess, requireResource, sendAgentRuntimeError } from "@/agent-runtime/http";
import { getAgentRun } from "@/agent-runtime/repository";
import { cancelAgentRun } from "@/agent-runtime/service";

const router = express.Router({ mergeParams: true });
router.use(requireAgentRuntimePreview);

export const bodySchema = z.object({ reason: z.string().trim().max(500).optional().nullable() });

router.post("/", async (req, res) => {
  try {
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).send({ code: "invalid_request", message: "参数错误", errors: parsed.error.issues });
    const actor = getAgentRequestActor(req);
    const run = requireResource(
      await getAgentRun({ id: String((req.params as any).id || ""), workspaceId: actor.workspaceId }),
      "run_not_found",
      "Agent Run 不存在",
    );
    await assertAgentProjectAccess(req, run.projectId, "project:write");
    const result = await cancelAgentRun({
      workspaceId: actor.workspaceId,
      runId: run.id,
      requestedBy: actor.userId,
      reason: parsed.data.reason,
    });
    return res.status(200).send(agentSuccess({ ...toAgentRunDto(result.run), replayed: result.replayed }));
  } catch (error) {
    return sendAgentRuntimeError(res, error);
  }
});

export default router;
