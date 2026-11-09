import express from "express";
import { z } from "zod";

import {
  beginNovelEventAnalysisTask,
  NovelEventTaskError,
  runNovelEventAnalysisTask,
  toPublicNovelEventTask,
} from "@/lib/novelEventAnalysisTask";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireInferredProjectPermission } from "@/middleware/projectAccess";

const router = express.Router();

export default router.post(
  "/",
  validateFields({
    ids: z.array(z.coerce.number().int().positive()).min(1).max(100),
    model: z.string().min(1).optional(),
    force: z.boolean().optional(),
  }),
  requireInferredProjectPermission("generation:create"),
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
        projectId: Number((req as any).project?.id || 0),
        novelIds: req.body.ids,
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
          console.error("[novel-event-analysis] legacy background task failed", {
            taskId: result.checkpoint.taskId,
            message: cause instanceof Error ? cause.message : String(cause),
          });
        });
      });
      return res.status(202).send(
        success({ task: toPublicNovelEventTask(result.checkpoint) }),
      );
    } catch (cause) {
      if (cause instanceof NovelEventTaskError) {
        return res.status(cause.status).send(
          error(cause.message, { code: cause.code }),
        );
      }
      throw cause;
    }
  },
);
