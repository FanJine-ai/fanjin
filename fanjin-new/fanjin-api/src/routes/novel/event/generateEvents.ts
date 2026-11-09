import express from "express";
import { z } from "zod";
import {
  beginNovelEventAnalysisTask,
  cancelNovelEventAnalysisTask,
  NovelEventTaskError,
  readNovelEventAnalysisTasks,
  runNovelEventAnalysisTask,
  toPublicNovelEventTask,
} from "@/lib/novelEventAnalysisTask";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";

const router = express.Router();

function sendTaskError(res: express.Response, cause: unknown) {
  if (cause instanceof NovelEventTaskError) {
    return res.status(cause.status).send(
      error(cause.message, {
        code: cause.code,
        ...(cause.task ? { task: cause.task } : {}),
      }),
    );
  }
  throw cause;
}

router.post(
  "/status",
  validateFields({
    projectId: z.number().int().positive(),
    taskIds: z.array(z.number().int().positive()).max(100).optional(),
  }),
  requireProjectPermission("project:read"),
  async (req, res) => {
    try {
      const tasks = await readNovelEventAnalysisTasks({
        workspaceId: String((req as any).auth?.workspaceId || ""),
        projectId: Number(req.body.projectId),
        taskIds: req.body.taskIds,
      });
      return res.status(200).send(success(tasks));
    } catch (cause) {
      return sendTaskError(res, cause);
    }
  },
);

router.post(
  "/cancel",
  validateFields({
    projectId: z.number().int().positive(),
    taskId: z.number().int().positive(),
  }),
  requireProjectPermission("generation:create"),
  async (req, res) => {
    try {
      const result = await cancelNovelEventAnalysisTask({
        workspaceId: String((req as any).auth?.workspaceId || ""),
        projectId: Number(req.body.projectId),
        taskId: Number(req.body.taskId),
      });
      return res.status(200).send(success(result));
    } catch (cause) {
      return sendTaskError(res, cause);
    }
  },
);

router.post(
  "/",
  validateFields({
    projectId: z.number().int().positive(),
    novelIds: z.array(z.number().int().positive()).min(1).max(100),
    model: z.string().min(1).optional(),
    force: z.boolean().optional(),
  }),
  requireProjectPermission("generation:create"),
  async (req, res) => {
    if (process.env.FANJIN_DISABLE_NOVEL_EVENT_EXTRACTION === "1") {
      return res.status(503).send(
        error("当前环境未启用小说事件分析", {
          code: "NOVEL_EVENT_ANALYSIS_DISABLED",
        }),
      );
    }
    try {
      const result = await beginNovelEventAnalysisTask({
        workspaceId: String((req as any).auth?.workspaceId || ""),
        actorUserId: Number((req as any).auth?.user?.id || 0),
        projectId: Number(req.body.projectId),
        novelIds: req.body.novelIds,
        model: req.body.model,
        force: req.body.force,
        idempotencyKey: req.header("idempotency-key"),
      });
      if (result.kind === "replay") {
        return res
          .status(result.responseStatus)
          .send(success(result.responseBody));
      }
      setImmediate(() => {
        void runNovelEventAnalysisTask(result).catch((cause) => {
          console.error("[novel-event-analysis] background task failed", {
            taskId: result.checkpoint.taskId,
            message: cause instanceof Error ? cause.message : String(cause),
          });
        });
      });
      return res.status(202).send(
        success({ task: toPublicNovelEventTask(result.checkpoint) }),
      );
    } catch (cause) {
      return sendTaskError(res, cause);
    }
  },
);

export default router;
