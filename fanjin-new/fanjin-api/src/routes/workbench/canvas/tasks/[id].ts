import express from "express";
import {
  cancelOrDeleteRelayTask,
  formatPublicRelayTask,
  getRelayTask,
  RelayWorkerCancellationRequiredError,
  refreshRelayTask,
} from "@/lib/relay";
import { CanvasTaskLookupError, lookupCanvasTask } from "@/lib/canvasTaskLookup";
import { requireActiveWorkspacePermission } from "@/middleware/permissions";

const router = express.Router({ mergeParams: true });

function taskId(req: express.Request): string {
  const value = req.params.id;
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

router.get(
  "/",
  requireActiveWorkspacePermission("project:read"),
  async (req, res) => {
    const id = taskId(req).trim();
    if (!id || id.length > 200) return res.status(400).send({ message: "任务 ID 无效" });

    try {
      const { task, view } = await lookupCanvasTask(id, (req as any).auth);
      if (view) return res.status(200).send(view);
      if (!task) return res.status(404).send({ code: "TASK_NOT_FOUND", message: "任务不存在" });
      return res.status(200).send(await formatPublicRelayTask(await refreshRelayTask(task)));
    } catch (error) {
      if (error instanceof CanvasTaskLookupError) return res.status(error.status).send({ code: error.code, message: error.message });
      return res.status(500).send({ message: "任务查询暂时不可用" });
    }
  },
);

router.delete(
  "/",
  requireActiveWorkspacePermission("generation:create"),
  async (req, res) => {
    const id = taskId(req).trim();
    if (!id || id.length > 200) return res.status(400).send({ message: "任务 ID 无效" });

    try {
      const task = await getRelayTask(id);
      if (!task) return res.status(404).send({ message: "任务不存在" });
      const result = await cancelOrDeleteRelayTask(id, {
        actorUserId: Number((req as any).auth?.user?.id || 0),
      });
      if (result.cancelled && result.task) {
        return res.status(200).send(await formatPublicRelayTask(result.task));
      }
      return res.status(409).send({ message: "当前任务状态不支持取消" });
    } catch (error) {
      if (error instanceof RelayWorkerCancellationRequiredError) {
        return res.status(error.status).send({
          name: error.name,
          code: error.code,
          message: error.message,
        });
      }
      const status = Number((error as any)?.status || (error as any)?.statusCode || 0);
      if (status >= 400 && status < 500) {
        return res.status(status).send({ code: (error as any)?.code || "TASK_CANCEL_FORBIDDEN", message: (error as any)?.message || "无权取消该任务" });
      }
      return res.status(500).send({ message: "任务取消暂时不可用" });
    }
  },
);

export default router;
