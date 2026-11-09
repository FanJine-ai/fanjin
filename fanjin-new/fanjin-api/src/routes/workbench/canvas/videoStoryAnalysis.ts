import express from "express";
import { z } from "zod";

import { inspectVideoStoryAnalyzerConfiguration } from "@/lib/videoStoryAnalyzer";
import {
  beginVideoStoryAnalysisTask,
  cancelVideoStoryAnalysisTask,
  readVideoStoryAnalysisTasks,
  resumeVideoStoryAnalysisTask,
  scheduleVideoStoryAnalysisTask,
  toPublicVideoStoryTask,
  VideoStoryTaskError,
} from "@/lib/videoStoryAnalysisTask";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireProjectPermission } from "@/middleware/projectAccess";

const router = express.Router();

function sendTaskError(res: express.Response, cause: unknown) {
  if (cause instanceof VideoStoryTaskError) {
    return res.status(cause.status).send(error(cause.message, {
      code: cause.code,
      ...(cause.task ? { task: cause.task } : {}),
    }));
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
      const tasks = await readVideoStoryAnalysisTasks({
        workspaceId: String((req as any).auth?.workspaceId || ""),
        projectId: Number(req.body.projectId),
        taskIds: req.body.taskIds,
      });
      tasks.forEach((task) => {
        if (!["queued", "running", "persisting"].includes(task.state)) return;
        setImmediate(() => {
          void resumeVideoStoryAnalysisTask({
            workspaceId: String((req as any).auth?.workspaceId || ""),
            projectId: Number(req.body.projectId),
            taskId: task.taskId,
          }).catch((cause) => {
            console.error("[video-story-analysis] recovery failed", {
              taskId: task.taskId,
              message: cause instanceof Error ? cause.message : String(cause),
            });
          });
        });
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
      const result = await cancelVideoStoryAnalysisTask({
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
    assetVersionId: z.number().int().positive(),
    title: z.string().trim().min(1).max(500).optional(),
    maximumShots: z.number().int().min(1).max(40).optional(),
    rightsConfirmed: z.literal(true),
    retryOfTaskId: z.number().int().positive().optional(),
  }),
  requireProjectPermission("generation:create"),
  async (req, res) => {
    const readiness = inspectVideoStoryAnalyzerConfiguration();
    if (!readiness.available) {
      return res.status(503).send(error("当前服务未配置 FFmpeg/ffprobe，逐帧拉片不可用", {
        code: readiness.reason || "video_story_analyzer_unavailable",
      }));
    }
    try {
      const result = await beginVideoStoryAnalysisTask({
        workspaceId: String((req as any).auth?.workspaceId || ""),
        actorUserId: Number((req as any).auth?.user?.id || 0),
        projectId: Number(req.body.projectId),
        assetVersionId: Number(req.body.assetVersionId),
        title: req.body.title,
        maximumShots: req.body.maximumShots,
        rightsConfirmed: req.body.rightsConfirmed,
        retryOfTaskId: req.body.retryOfTaskId,
        idempotencyKey: req.header("idempotency-key"),
      });
      if (result.kind === "replay") {
        return res.status(result.responseStatus).send(success(result.responseBody));
      }
      setImmediate(() => {
        void scheduleVideoStoryAnalysisTask(result).catch((cause) => {
          console.error("[video-story-analysis] background task failed", {
            taskId: result.checkpoint.taskId,
            message: cause instanceof Error ? cause.message : String(cause),
          });
        });
      });
      return res.status(202).send(success({ task: toPublicVideoStoryTask(result.checkpoint) }));
    } catch (cause) {
      return sendTaskError(res, cause);
    }
  },
);

export default router;
