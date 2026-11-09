import express from "express";
import type { Knex } from "knex";
import { z } from "zod";
import { toSafeAgentApprovalDto } from "@/agent-runtime/approvalDto";
import { AgentApprovalService } from "@/agent-runtime/approvalService";
import { requireAgentRuntimePreview } from "@/agent-runtime/featureFlags";
import { assertAgentProjectAccess, getAgentRequestActor } from "@/agent-runtime/httpAccess";
import { agentSuccess, sendAgentRuntimeError } from "@/agent-runtime/http";
import { reviseAgentApprovalModelTurnCheckpointInTransaction } from "@/agent-runtime/toolLoopProcessor";
import { db } from "@/utils/db";

const router = express.Router({ mergeParams: true });
const approvalService = new AgentApprovalService(db as unknown as Knex);
router.use(requireAgentRuntimePreview);

export const decisionSchema = z.object({
  decision: z.enum(["approved", "denied"]),
  expectedRevision: z.number().int().positive(),
  /** REVAMP-PLAN 1.2: optional revised tool arguments for approve-with-revision. */
  revisedArguments: z.record(z.string(), z.unknown()).optional(),
}).strict();

router.post("/", async (req, res) => {
  try {
    const parsed = decisionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).send({ code: "invalid_request", message: "参数错误", errors: parsed.error.issues });
    }
    const actor = getAgentRequestActor(req);
    const approvalId = String((req.params as any).id || "");
    const persisted = await approvalService.getForWorkspace({
      workspaceId: actor.workspaceId,
      approvalId,
    });
    await assertAgentProjectAccess(req, persisted.projectId, "project:write");
    const updated = await approvalService.decide({
      workspaceId: actor.workspaceId,
      projectId: persisted.projectId,
      approvalId,
      decision: parsed.data.decision,
      decidedBy: actor.userId,
      expectedRevision: parsed.data.expectedRevision,
      appendEvent: true,
      resumeWaitingRun: true,
      ...(parsed.data.revisedArguments === undefined
        ? {}
        : {
            revisedArguments: parsed.data.revisedArguments,
            applyRevisionInTransaction: reviseAgentApprovalModelTurnCheckpointInTransaction,
          }),
    });
    return res.status(200).send(agentSuccess(toSafeAgentApprovalDto(updated)));
  } catch (error) {
    return sendAgentRuntimeError(res, error);
  }
});

export default router;
