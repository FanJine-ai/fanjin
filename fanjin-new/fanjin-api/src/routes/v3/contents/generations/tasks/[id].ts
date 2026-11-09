import express from "express";
import { apiKeyAuth } from "@/middleware/apiKeyAuth";
import { canAccessRelayTask, cancelOrDeleteRelayTask, formatPublicRelayTask, getRelayTask, refreshRelayTask } from "@/lib/relay";

const router = express.Router({ mergeParams: true });

function getTaskId(req: express.Request): string {
  const value = req.params.id;
  return Array.isArray(value) ? value[0] : value;
}

router.get("/", apiKeyAuth({ permission: "relay:video_generation", checkQuota: false }), async (req, res) => {
  const taskId = getTaskId(req);
  const task = await getRelayTask(taskId);
  if (!task) return res.status(404).send({ error: { message: "任务不存在" } });
  if (!canAccessRelayTask(task, { apiKey: (req as any).apiKey, auth: (req as any).auth })) {
    return res.status(403).send({ error: { message: "无权访问该任务" } });
  }

  res.status(200).send(await formatPublicRelayTask(await refreshRelayTask(task)));
});

router.delete("/", apiKeyAuth({ permission: "relay:video_generation", checkQuota: false }), async (req, res) => {
  const taskId = getTaskId(req);
  const task = await getRelayTask(taskId);
  if (!task) return res.status(404).send({ error: { message: "任务不存在" } });
  if (!canAccessRelayTask(task, { apiKey: (req as any).apiKey, auth: (req as any).auth })) {
    return res.status(403).send({ error: { message: "无权访问该任务" } });
  }

  let result;
  try {
    result = await cancelOrDeleteRelayTask(taskId, {
      actorUserId: Number((req as any).apiKey?.ownerUserId || (req as any).auth?.user?.id || 0),
      apiKey: (req as any).apiKey,
    });
  } catch (error: any) {
    const status = Number(error?.status || error?.statusCode || 403);
    return res.status(status >= 400 && status < 500 ? status : 403).send({ error: { message: error?.message || "无权取消该任务" } });
  }
  if (result.cancelled && result.task) return res.status(200).send(await formatPublicRelayTask(result.task));

  return res.status(409).send({ error: { message: "当前任务状态不支持取消" } });
});

export default router;
