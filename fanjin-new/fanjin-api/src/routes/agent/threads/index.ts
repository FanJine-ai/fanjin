import express from "express";
import { z } from "zod";
import { assertAgentProjectAccess, getAgentRequestActor } from "@/agent-runtime/httpAccess";
import { toAgentThreadDto } from "@/agent-runtime/dto";
import { requireAgentRuntimePreview } from "@/agent-runtime/featureFlags";
import { agentSuccess, sendAgentRuntimeError } from "@/agent-runtime/http";
import { isAgentThreadCursor, listAgentThreads } from "@/agent-runtime/repository";
import { createAgentThread, ensureAgentThread } from "@/agent-runtime/service";
import { toCreationSessionDto } from "@/lib/creationSessionService";
import { requireWorkspacePermission } from "@/middleware/permissions";

const router = express.Router();
router.use(requireAgentRuntimePreview);

export const createSchema = z.object({
  projectId: z.number().int().positive(),
  sessionId: z.string().trim().min(1).max(200).optional().nullable(),
  title: z.string().trim().max(120).optional().nullable(),
});

export const listSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  before: z.string().max(500).refine(isAgentThreadCursor, "无效分页游标").optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const ensureSchema = z.object({
  projectId: z.number().int().positive().optional().nullable(),
  projectName: z.string().trim().max(120).optional().nullable(),
  sessionId: z.string().trim().min(1).max(200).optional().nullable(),
  session: z.object({
    goal: z.string().trim().max(4_000).optional(),
    mode: z.enum(["agent", "quick_create", "canvas"]).optional(),
    inputs: z.array(z.unknown()).max(100).optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    selectedAssetVersionIds: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
    canvasId: z.string().trim().min(1).max(200).optional().nullable(),
  }).strict().optional(),
  title: z.string().trim().max(120).optional().nullable(),
}).strict();

router.post("/ensure", requireWorkspacePermission("project:write"), async (req, res) => {
  try {
    // This is an authenticated pre-Run service command, not an Agent Tool.
    // Workspace and actor identity always come from middleware; strict request
    // parsing prevents a client (or future model adapter) from smuggling either
    // identity into the command body.
    const parsed = ensureSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).send({ code: "invalid_request", message: "参数错误", errors: parsed.error.issues });
    }
    const actor = getAgentRequestActor(req);
    if (parsed.data.projectId) {
      await assertAgentProjectAccess(req, parsed.data.projectId, "project:write");
    }
    const result = await ensureAgentThread({
      workspaceId: actor.workspaceId,
      projectId: parsed.data.projectId,
      projectName: parsed.data.projectName,
      sessionId: parsed.data.sessionId,
      session: parsed.data.session,
      title: parsed.data.title,
      createdBy: actor.userId,
      idempotencyKey: String(req.headers["idempotency-key"] || ""),
    });
    return res.status(result.replayed ? 200 : 201).send(agentSuccess({
      project: result.project,
      session: toCreationSessionDto(result.session),
      thread: toAgentThreadDto(result.thread),
      replayed: result.replayed,
    }));
  } catch (error) {
    return sendAgentRuntimeError(res, error);
  }
});

router.post("/", async (req, res) => {
  try {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).send({ code: "invalid_request", message: "参数错误", errors: parsed.error.issues });
    const access = await assertAgentProjectAccess(req, parsed.data.projectId, "project:write");
    const idempotencyKey = String(req.headers["idempotency-key"] || "");
    const result = await createAgentThread({
      workspaceId: access.workspaceId,
      projectId: parsed.data.projectId,
      sessionId: parsed.data.sessionId,
      title: parsed.data.title,
      createdBy: access.actor.userId,
      idempotencyKey,
    });
    return res
      .status(result.replayed ? 200 : 201)
      .send(agentSuccess({ ...toAgentThreadDto(result.thread), replayed: result.replayed }));
  } catch (error) {
    return sendAgentRuntimeError(res, error);
  }
});

router.get("/", async (req, res) => {
  try {
    const parsed = listSchema.safeParse(req.query ?? {});
    if (!parsed.success) return res.status(400).send({ code: "invalid_request", message: "参数错误", errors: parsed.error.issues });
    const access = await assertAgentProjectAccess(req, parsed.data.projectId, "project:read");
    const page = await listAgentThreads({
      workspaceId: access.workspaceId,
      projectId: parsed.data.projectId,
      before: parsed.data.before,
      limit: parsed.data.limit,
    });
    return res.status(200).send(agentSuccess({
      data: page.data.map(toAgentThreadDto),
      nextCursor: page.nextCursor,
    }));
  } catch (error) {
    return sendAgentRuntimeError(res, error);
  }
});

export default router;
