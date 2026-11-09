import express from "express";
import { z } from "zod";
import { assertAgentProjectAccess } from "@/agent-runtime/httpAccess";
import { agentSuccess, sendAgentRuntimeError } from "@/agent-runtime/http";
import {
  ensureCurrentCreationSession,
  getCurrentCreationSession,
  toCreationSessionDto,
} from "@/lib/creationSessionService";

const router = express.Router({ mergeParams: true });
const paramsSchema = z.object({ projectId: z.coerce.number().int().positive() });
export const ensureSchema = z.object({
  goal: z.string().trim().max(20_000).optional(),
  mode: z.enum(["agent", "quick_create", "canvas"]).default("quick_create"),
  inputs: z.array(z.unknown()).max(100).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  selectedAssetVersionIds: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
  canvasId: z.string().trim().min(1).max(200).optional().nullable(),
}).strict();

router.get("/", async (req, res) => {
  try {
    const parsed = paramsSchema.safeParse(req.params);
    if (!parsed.success) return res.status(400).send({ code: "invalid_request", message: "projectId 无效" });
    const access = await assertAgentProjectAccess(req, parsed.data.projectId, "project:read");
    const session = await getCurrentCreationSession({
      workspaceId: access.workspaceId,
      projectId: parsed.data.projectId,
    });
    return res.status(200).send(agentSuccess(session ? toCreationSessionDto(session) : null));
  } catch (error) {
    return sendAgentRuntimeError(res, error);
  }
});

router.post("/", async (req, res) => {
  try {
    const params = paramsSchema.safeParse(req.params);
    const body = ensureSchema.safeParse(req.body ?? {});
    if (!params.success || !body.success) {
      return res.status(400).send({ code: "invalid_request", message: "参数错误" });
    }

    const access = await assertAgentProjectAccess(req, params.data.projectId, "project:write");
    const result = await ensureCurrentCreationSession({
      workspaceId: access.workspaceId,
      projectId: params.data.projectId,
      createdBy: access.actor.userId,
      draft: body.data,
    });
    return res.status(result.created ? 201 : 200).send(agentSuccess({
      session: toCreationSessionDto(result.session),
      created: result.created,
    }));
  } catch (error) {
    return sendAgentRuntimeError(res, error);
  }
});

export default router;
