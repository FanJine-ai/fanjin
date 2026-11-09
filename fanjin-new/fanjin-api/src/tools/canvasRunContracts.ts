import { z } from "zod";
import { generationRequestSchema } from "./creationContracts";
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const nodeId = z.string().min(1).max(128);
const gu = z.string().regex(/^\d+(?:\.\d{1,8})?$/).max(30);
const definition = (title: string, description: string, schema: z.ZodObject, readOnly = false) => ({
  title, description, schema, readOnly,
  keyPermission: readOnly ? "generation:read" : "generation:create",
  memberPermission: readOnly ? "project:read" : "generation:create",
});
export const canvasRunDefinitions = {
  fanjin_canvas_run_start: definition("后台执行一组画布节点", "保存节点请求和已获授权的总预算，按画布依赖依次报价、提交、等待并回填。先读取画布及模型能力，传每个节点的完整 request；依赖本组新作品用 outputReferences。断线/重启继续原任务；失败、预算不足或画布冲突暂停，不自动重投。budgetGu 是整组所有已受理任务的最高报价合计上限，不是实际扣费。", z.strictObject({
    projectId: id, canvasId: id, expectedRevision: id, budgetGu: gu,
    idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
    steps: z.array(z.strictObject({ nodeId, request: generationRequestSchema,
      outputReferences: z.array(z.strictObject({ nodeId, assetIndex: z.number().int().min(0).max(9).default(0),
        role: z.enum(["subject", "style", "storyboard", "first_frame", "last_frame", "source_video"]),
      })).max(50).default([]),
    })).min(1).max(50),
  })),
  fanjin_canvas_run_get: definition("查询整组任务进度", "返回每个节点的原任务编号、作品和回填状态；已授权上限与已受理报价合计独立展示，实际账单仍通过 fanjin_task_billing 查询。", z.strictObject({ runId: z.string().uuid() }), true),
  fanjin_canvas_runs_list: definition("列出可恢复的画布任务", "按项目/画布查询当前密钥发起的后台执行，断线后无需记住任务编号。", z.strictObject({ projectId: id, canvasId: id.optional(), limit: id.max(50).default(20) }), true),
  fanjin_canvas_run_control: definition("暂停、继续或停止整组任务", "暂停/停止不再派发后续节点，已受理的单节点任务保留并继续交付，不伪报取消或退款。继续使用原任务；可显式提高总预算或确认新的画布 revision；失败节点不自动重投。expectedVersion 使用最新查询值。", z.strictObject({
    runId: z.string().uuid(), expectedVersion: id, action: z.enum(["pause", "resume", "cancel"]),
    budgetGu: gu.optional(), expectedRevision: id.optional(),
  })),
};
