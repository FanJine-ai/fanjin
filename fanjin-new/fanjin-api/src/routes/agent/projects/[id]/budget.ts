import express from "express";
import { z } from "zod";
import { AgentRuntimeError } from "@/agent-runtime/errors";
import { isAgentAutoApproveEnabled, requireAgentRuntimePreview } from "@/agent-runtime/featureFlags";
import { assertAgentProjectAccess, getAgentRequestActor } from "@/agent-runtime/httpAccess";
import { agentSuccess, sendAgentRuntimeError } from "@/agent-runtime/http";
import {
  AGENT_PROJECT_BUDGET_COLUMN,
  AGENT_PROJECT_BUDGET_RESERVED_COLUMN,
  PROJECT_TABLE,
} from "@/lib/migrations/agentProjectBudget";
import { db } from "@/utils/db";

/**
 * 项目级 Agent GU 预算(预算自主审批)。
 * GET 读预算(项目读权限);PUT 设/清预算(项目写权限,null = 清除 = 全人工)。
 * 预算的读写不受 FANJIN_AGENT_AUTO_APPROVE_ENABLED 控制;开关只控制自动批准
 * 执行分叉,DTO 回传 autoApproveEnabled 供前端提示当前灰度状态。
 */
const router = express.Router({ mergeParams: true });
router.use(requireAgentRuntimePreview);

export const putBudgetSchema = z.object({
  agentBudgetMicros: z.number().int().positive().safe().nullable(),
}).strict();

interface AgentProjectBudgetDto {
  projectId: number;
  agentBudgetMicros: number | null;
  agentBudgetReservedMicros: number;
  autoApproveEnabled: boolean;
}

function readProjectIdParam(req: express.Request): number {
  const projectId = Number((req.params as any).id || 0);
  if (!Number.isSafeInteger(projectId) || projectId < 1) {
    throw new AgentRuntimeError(400, "project_id_invalid", "项目 ID 无效");
  }
  return projectId;
}

async function loadBudgetDto(projectId: number, workspaceId: string): Promise<AgentProjectBudgetDto> {
  const project = await db(PROJECT_TABLE)
    .where({ id: projectId, workspaceId, deletionState: "active" })
    .select(AGENT_PROJECT_BUDGET_COLUMN, AGENT_PROJECT_BUDGET_RESERVED_COLUMN)
    .first();
  if (!project) throw new AgentRuntimeError(404, "project_not_found", "项目不存在");
  const row = project as Record<string, unknown>;
  const budget = row[AGENT_PROJECT_BUDGET_COLUMN] == null ? null : Number(row[AGENT_PROJECT_BUDGET_COLUMN]);
  const reserved = Number(row[AGENT_PROJECT_BUDGET_RESERVED_COLUMN] ?? 0);
  return {
    projectId,
    agentBudgetMicros: budget,
    agentBudgetReservedMicros: Number.isSafeInteger(reserved) && reserved > 0 ? reserved : 0,
    autoApproveEnabled: isAgentAutoApproveEnabled(),
  };
}

router.get("/", async (req, res) => {
  try {
    const projectId = readProjectIdParam(req);
    const { actor } = await assertAgentProjectAccess(req, projectId, "project:read");
    return res.status(200).send(agentSuccess(await loadBudgetDto(projectId, actor.workspaceId)));
  } catch (error) {
    return sendAgentRuntimeError(res, error);
  }
});

router.put("/", async (req, res) => {
  try {
    const parsed = putBudgetSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).send({ code: "invalid_request", message: "参数错误", errors: parsed.error.issues });
    }
    const projectId = readProjectIdParam(req);
    const { actor } = await assertAgentProjectAccess(req, projectId, "project:write");
    const updated = await db(PROJECT_TABLE)
      .where({
        id: projectId,
        workspaceId: actor.workspaceId,
        deletionState: "active",
      })
      .update({
        [AGENT_PROJECT_BUDGET_COLUMN]: parsed.data.agentBudgetMicros,
        updatedAt: Date.now(),
      });
    if (Number(updated) !== 1) throw new AgentRuntimeError(404, "project_not_found", "项目不存在");
    return res.status(200).send(agentSuccess(await loadBudgetDto(projectId, actor.workspaceId)));
  } catch (error) {
    return sendAgentRuntimeError(res, error);
  }
});

export default router;
