import express from "express";
import { requireAgentRuntimePreview } from "@/agent-runtime/featureFlags";
import { toAgentThreadDto } from "@/agent-runtime/dto";
import { assertAgentProjectAccess, getAgentRequestActor } from "@/agent-runtime/httpAccess";
import { agentSuccess, requireResource, sendAgentRuntimeError } from "@/agent-runtime/http";
import { getAgentThread } from "@/agent-runtime/repository";

const router = express.Router({ mergeParams: true });
router.use(requireAgentRuntimePreview);

router.get("/", async (req, res) => {
  try {
    const actor = getAgentRequestActor(req);
    const thread = requireResource(
      await getAgentThread({ id: String((req.params as any).id || ""), workspaceId: actor.workspaceId }),
      "thread_not_found",
      "Agent Thread 不存在",
    );
    await assertAgentProjectAccess(req, thread.projectId, "project:read");
    return res.status(200).send(agentSuccess(toAgentThreadDto(thread)));
  } catch (error) {
    return sendAgentRuntimeError(res, error);
  }
});

export default router;
