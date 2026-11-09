import express from "express";
import { z } from "zod";
import { cancelOrDeleteRelayTask, getRelayTask } from "@/lib/relay";
import { success } from "@/lib/responseFormat";
import { writeAuditLog } from "@/lib/audit";
import { requirePlatformAdmin } from "@/middleware/permissions";
import { adminRelayTaskResponse } from "@/lib/relayResponseRedaction";

const router = express.Router();
router.use(requirePlatformAdmin);

const bodySchema = z.object({
  id: z.string().min(1),
});

export default router.post("/", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).send({ message: "参数错误", errors: parsed.error.issues });

  const task = await getRelayTask(parsed.data.id);
  if (!task) return res.status(404).send({ message: "任务不存在" });

  const result = await cancelOrDeleteRelayTask(parsed.data.id, { internal: true });
  if (!result.cancelled || !result.task) {
    return res.status(409).send({ message: "当前任务状态不支持取消" });
  }

  await writeAuditLog(req, {
    workspaceId: result.task.workspaceId,
    action: "relay_task.cancel",
    resourceType: "relay_task",
    resourceId: result.task.id,
    metadata: {
      previousStatus: task.status,
      nextStatus: result.task.status,
      provider: result.task.provider,
      providerTaskId: result.task.providerTaskId,
    },
  });

  return res.status(200).send(success(adminRelayTaskResponse(result.task)));
});
