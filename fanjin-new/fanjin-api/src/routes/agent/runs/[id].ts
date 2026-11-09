import express from "express";
import { toAgentRunDto } from "@/agent-runtime/dto";
import { requireAgentRuntimePreview } from "@/agent-runtime/featureFlags";
import { assertAgentProjectAccess, getAgentRequestActor } from "@/agent-runtime/httpAccess";
import { agentSuccess, requireResource, sendAgentRuntimeError } from "@/agent-runtime/http";
import { getAgentRun } from "@/agent-runtime/repository";

const router = express.Router({ mergeParams: true });
router.use(requireAgentRuntimePreview);

router.get("/", async (req, res) => {
  try {
    const actor = getAgentRequestActor(req);
    const run = requireResource(
      await getAgentRun({ id: String((req.params as any).id || ""), workspaceId: actor.workspaceId }),
      "run_not_found",
      "Agent Run 不存在",
    );
    await assertAgentProjectAccess(req, run.projectId, "project:read");
    return res.status(200).send(agentSuccess(toAgentRunDto(run)));
  } catch (error) {
    return sendAgentRuntimeError(res, error);
  }
});

export default router;
