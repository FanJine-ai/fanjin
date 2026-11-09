import express from "express";
import { agentSuccess, sendAgentRuntimeError } from "@/agent-runtime/http";
import { getAgentRequestActor } from "@/agent-runtime/httpAccess";
import { AGENT_SKILL_BILLING_POLICY } from "@/agent-runtime/agentBillingPolicy";
import { listPublicAgentSkills } from "@/agent-runtime/publicSkillCatalog";

const router = express.Router({ mergeParams: true });

// GET /api/agent/skills — authenticated canonical catalog for user skill
// discovery. It exposes reviewed presentation metadata but never Runtime
// instructions, source paths or content hashes. This read-only control-plane catalog remains
// readable when the Runtime data plane is disabled. Catalog membership does
// not assert executability: callers must use /api/agent/chat-models as the
// fail-closed Worker/model/tool availability gate before enabling Agent work.
router.get("/", async (req, res) => {
  try {
    getAgentRequestActor(req);
    const skills = listPublicAgentSkills().map((skill) => ({
      ...skill,
      billingPolicy: { ...AGENT_SKILL_BILLING_POLICY },
    }));
    return res.status(200).send(agentSuccess({ skills }));
  } catch (error) {
    return sendAgentRuntimeError(res, error);
  }
});

export default router;
